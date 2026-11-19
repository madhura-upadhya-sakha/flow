BEGIN;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS board_position integer
    CHECK (board_position IS NULL OR board_position > 0);

CREATE TABLE IF NOT EXISTS task_activity (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL CHECK (action IN ('created', 'updated', 'commented')),
    changed_fields text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS task_activity_history_idx
    ON task_activity(workspace_id, task_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION flow_record_task_activity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    changed text[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO task_activity (workspace_id, task_id, actor_id, action)
        VALUES (NEW.workspace_id, NEW.id, NEW.created_by, 'created');
        RETURN NEW;
    END IF;

    changed := array_remove(ARRAY[
        CASE WHEN NEW.title IS DISTINCT FROM OLD.title THEN 'Title' END,
        CASE WHEN NEW.description IS DISTINCT FROM OLD.description THEN 'Description' END,
        CASE WHEN NEW.project_id IS DISTINCT FROM OLD.project_id THEN 'Project' END,
        CASE WHEN NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN 'Assignee' END,
        CASE WHEN NEW.priority IS DISTINCT FROM OLD.priority THEN 'Priority' END,
        CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN 'Status' END,
        CASE WHEN NEW.due_date IS DISTINCT FROM OLD.due_date THEN 'Due date' END
    ], NULL);

    IF cardinality(changed) > 0 THEN
        INSERT INTO task_activity (workspace_id, task_id, actor_id, action, changed_fields)
        VALUES (NEW.workspace_id, NEW.id, NEW.updated_by, 'updated', changed);
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION flow_record_task_comment_activity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO task_activity (workspace_id, task_id, actor_id, action)
    VALUES (NEW.workspace_id, NEW.task_id, NEW.author_id, 'commented');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flow_task_activity ON tasks;
CREATE TRIGGER flow_task_activity AFTER INSERT OR UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION flow_record_task_activity();

DROP TRIGGER IF EXISTS flow_task_comment_activity ON task_comments;
CREATE TRIGGER flow_task_comment_activity AFTER INSERT ON task_comments
    FOR EACH ROW EXECUTE FUNCTION flow_record_task_comment_activity();

COMMIT;
