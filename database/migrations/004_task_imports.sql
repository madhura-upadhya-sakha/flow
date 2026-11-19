BEGIN;

CREATE TABLE IF NOT EXISTS task_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    request_id uuid NOT NULL,
    project_id uuid NOT NULL,
    project_name text NOT NULL,
    source_hash text NOT NULL,
    task_count integer NOT NULL CHECK (task_count BETWEEN 1 AND 100),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, actor_id, request_id)
);

CREATE INDEX IF NOT EXISTS task_imports_history_idx
    ON task_imports(workspace_id, created_at DESC, id DESC);

COMMIT;
