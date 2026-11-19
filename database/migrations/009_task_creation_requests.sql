BEGIN;
ALTER TABLE tasks
    ADD COLUMN create_request_id uuid,
    ADD COLUMN create_request_hash text,
    ADD CHECK ((create_request_id IS NULL) = (create_request_hash IS NULL)),
    ADD UNIQUE (workspace_id, created_by, create_request_id);
COMMIT;
