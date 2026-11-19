BEGIN;

ALTER TABLE tasks
    ADD COLUMN approval text NOT NULL DEFAULT 'Not required'
        CHECK (approval IN ('Not required', 'Pending', 'Approved', 'Changes requested')),
    ADD COLUMN blocking_task_id uuid,
    ADD COLUMN parent_task_id uuid,
    ADD COLUMN subtask_request_id uuid,
    ADD FOREIGN KEY (blocking_task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE SET NULL (blocking_task_id),
    ADD FOREIGN KEY (parent_task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE SET NULL (parent_task_id),
    ADD CHECK (blocking_task_id <> id),
    ADD CHECK (parent_task_id <> id),
    ADD UNIQUE (workspace_id, parent_task_id, subtask_request_id);

CREATE INDEX task_blocking_dependency_idx ON tasks(workspace_id, blocking_task_id) WHERE blocking_task_id IS NOT NULL;

CREATE TABLE task_attachment_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE CASCADE,
    UNIQUE (task_id, url)
);

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
