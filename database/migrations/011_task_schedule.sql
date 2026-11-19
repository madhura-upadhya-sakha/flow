BEGIN;

ALTER TABLE tasks ADD COLUMN start_date date,
    ADD CONSTRAINT ck_tasks_schedule_range CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date);

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
        CASE WHEN NEW.start_date IS DISTINCT FROM OLD.start_date THEN 'Start date' END,
        CASE WHEN NEW.due_date IS DISTINCT FROM OLD.due_date THEN 'Due date' END,
        CASE WHEN NEW.estimate_minutes IS DISTINCT FROM OLD.estimate_minutes THEN 'Estimate' END,
        CASE WHEN NEW.approval IS DISTINCT FROM OLD.approval THEN 'Approval' END,
        CASE WHEN NEW.blocking_task_id IS DISTINCT FROM OLD.blocking_task_id THEN 'Blocking dependency' END
    ], NULL);

    IF cardinality(changed) > 0 THEN
        INSERT INTO task_activity (workspace_id, task_id, actor_id, action, changed_fields, status_after)
        VALUES (NEW.workspace_id, NEW.id, NEW.updated_by, 'updated', changed, CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN NEW.status END);
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
