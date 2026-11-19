BEGIN;

CREATE TABLE IF NOT EXISTS task_comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    author_id uuid NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE CASCADE,
    UNIQUE (task_id, author_id, request_id)
);

CREATE INDEX IF NOT EXISTS task_comments_history_idx
    ON task_comments(workspace_id, task_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION flow_task_comment_notification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM flow_notify(t.workspace_id, t.assignee_id, NEW.author_id,
        'comment', 'New comment on your task', t.title, 'task', t.id)
    FROM tasks t
    WHERE t.id = NEW.task_id AND t.workspace_id = NEW.workspace_id
      AND t.assignee_id <> NEW.author_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flow_notify_task_comment ON task_comments;
CREATE TRIGGER flow_notify_task_comment AFTER INSERT ON task_comments
    FOR EACH ROW EXECUTE FUNCTION flow_task_comment_notification();

COMMIT;
