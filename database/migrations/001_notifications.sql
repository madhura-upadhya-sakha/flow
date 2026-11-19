BEGIN;

CREATE TABLE IF NOT EXISTS user_identities (
    issuer text NOT NULL,
    subject text NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (issuer, subject)
);

CREATE TABLE IF NOT EXISTS notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    type text NOT NULL CHECK (type IN ('assignment', 'status', 'deadline', 'comment', 'membership')),
    title text NOT NULL,
    body text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    read_at timestamptz,
    FOREIGN KEY (workspace_id, recipient_user_id)
        REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS notifications_inbox_idx
    ON notifications(workspace_id, recipient_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx
    ON notifications(workspace_id, recipient_user_id, created_at DESC, id DESC)
    WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_preferences (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('assignment', 'deadline', 'comment', 'membership')),
    in_app_enabled boolean NOT NULL,
    PRIMARY KEY (workspace_id, user_id, event_type),
    FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION flow_notify(
    workspace uuid, recipient uuid, actor uuid, event_type text,
    event_title text, event_body text, target_type text, target_id uuid
) RETURNS void LANGUAGE sql AS $$
    INSERT INTO notifications(workspace_id, recipient_user_id, actor_user_id, type, title, body, entity_type, entity_id)
    SELECT workspace, recipient, actor, event_type, event_title, event_body, target_type, target_id
    WHERE recipient IS NOT NULL
      AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = workspace AND user_id = recipient)
      AND NOT EXISTS (
          SELECT 1 FROM notification_preferences p
          WHERE p.workspace_id = workspace AND p.user_id = recipient
            AND p.event_type = flow_notify.event_type AND NOT p.in_app_enabled
      );
$$;

CREATE OR REPLACE FUNCTION flow_task_notifications()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN
        PERFORM flow_notify(NEW.workspace_id, NEW.assignee_id, NEW.updated_by,
            'assignment', 'Task assigned to you', NEW.title, 'task', NEW.id);
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM flow_notify(NEW.workspace_id, NEW.assignee_id, NEW.updated_by,
            'status', 'Task status changed', NEW.title || ' → ' || NEW.status, 'task', NEW.id);
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.due_date IS DISTINCT FROM OLD.due_date THEN
        PERFORM flow_notify(NEW.workspace_id, NEW.assignee_id, NEW.updated_by,
            'deadline', 'Task deadline changed', NEW.title || ' · ' ||
            COALESCE(to_char(NEW.due_date, 'YYYY-MM-DD'), 'No due date'), 'task', NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flow_notify_task ON tasks;
CREATE TRIGGER flow_notify_task AFTER INSERT OR UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION flow_task_notifications();

CREATE OR REPLACE FUNCTION flow_membership_notification()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    project_name text;
BEGIN
    SELECT name INTO project_name FROM projects WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id;
    PERFORM flow_notify(NEW.workspace_id, NEW.user_id, NEW.created_by,
        'membership', 'Project membership added', project_name, 'project', NEW.project_id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flow_notify_project_member ON project_members;
CREATE TRIGGER flow_notify_project_member AFTER INSERT ON project_members
    FOR EACH ROW EXECUTE FUNCTION flow_membership_notification();

COMMIT;
