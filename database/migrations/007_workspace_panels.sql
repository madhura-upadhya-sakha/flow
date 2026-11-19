BEGIN;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimate_minutes integer
    CHECK (estimate_minutes IS NULL OR estimate_minutes BETWEEN 1 AND 10080);

ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS weekly_capacity_minutes integer NOT NULL DEFAULT 2400
    CHECK (weekly_capacity_minutes BETWEEN 0 AND 10080);

ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS status_after varchar(64);

CREATE INDEX IF NOT EXISTS task_activity_workspace_recent_idx
    ON task_activity(workspace_id, created_at DESC, id DESC);

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
        CASE WHEN NEW.due_date IS DISTINCT FROM OLD.due_date THEN 'Due date' END,
        CASE WHEN NEW.estimate_minutes IS DISTINCT FROM OLD.estimate_minutes THEN 'Estimate' END
    ], NULL);

    IF cardinality(changed) > 0 THEN
        INSERT INTO task_activity (workspace_id, task_id, actor_id, action, changed_fields, status_after)
        VALUES (NEW.workspace_id, NEW.id, NEW.updated_by, 'updated', changed, CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN NEW.status END);
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
