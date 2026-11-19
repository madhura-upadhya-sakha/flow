BEGIN;

CREATE TABLE IF NOT EXISTS workspace_sprints (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    starts_on date NOT NULL,
    ends_on date NOT NULL CHECK (ends_on >= starts_on),
    PRIMARY KEY (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS workspace_departments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    description text,
    UNIQUE (workspace_id, name)
);

COMMIT;
