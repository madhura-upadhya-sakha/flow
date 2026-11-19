BEGIN;

CREATE TABLE task_attachment_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
    digest text NOT NULL,
    content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 5242880),
    size_bytes integer GENERATED ALWAYS AS (octet_length(content)) STORED,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE CASCADE,
    UNIQUE (task_id, name, digest)
);

COMMIT;
