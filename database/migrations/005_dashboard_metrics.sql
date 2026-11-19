BEGIN;

CREATE TABLE IF NOT EXISTS task_completions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id uuid NOT NULL,
    task_id uuid,
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS task_completions_week_idx
    ON task_completions(workspace_id, completed_at);

CREATE OR REPLACE FUNCTION flow_record_task_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF lower(NEW.status) IN ('done', 'completed', 'complete') AND
        (TG_OP = 'INSERT' OR lower(OLD.status) NOT IN ('done', 'completed', 'complete')) THEN
        INSERT INTO task_completions (workspace_id, task_id) VALUES (NEW.workspace_id, NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flow_task_completion ON tasks;
CREATE TRIGGER flow_task_completion AFTER INSERT OR UPDATE OF status ON tasks
    FOR EACH ROW EXECUTE FUNCTION flow_record_task_completion();

CREATE TABLE IF NOT EXISTS task_time_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    task_id uuid,
    user_id uuid NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    minutes integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
    logged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (task_id, user_id, request_id)
);
CREATE INDEX IF NOT EXISTS task_time_entries_week_idx
    ON task_time_entries(workspace_id, logged_at);

-- Keep historical totals when individual tasks are removed.
ALTER TABLE task_completions
    ALTER COLUMN task_id DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS task_completions_task_id_workspace_id_fkey,
    DROP CONSTRAINT IF EXISTS task_completions_workspace_id_fkey,
    ADD FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE SET NULL (task_id),
    ADD FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE task_time_entries
    ALTER COLUMN task_id DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS task_time_entries_task_id_workspace_id_fkey,
    DROP CONSTRAINT IF EXISTS task_time_entries_workspace_id_fkey,
    ADD FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE SET NULL (task_id),
    ADD FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

COMMIT;
