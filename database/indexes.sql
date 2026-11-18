-- Secondary indexes for expected workspace, membership, project, and task queries.
-- Primary-key and unique indexes are created by their constraints.

CREATE INDEX ix_workspace_members_user_workspace
    ON workspace_members (user_id, workspace_id);

CREATE INDEX ix_projects_workspace_status_updated
    ON projects (workspace_id, status, updated_at DESC, id);

CREATE INDEX ix_projects_workspace_due_date
    ON projects (workspace_id, due_date, id)
    WHERE due_date IS NOT NULL;

CREATE INDEX ix_project_members_user_project
    ON project_members (user_id, project_id);

CREATE INDEX ix_tasks_project_status_due_date
    ON tasks (project_id, status, due_date, id);

CREATE INDEX ix_tasks_assignee_status_due_date
    ON tasks (assignee_id, status, due_date, id)
    WHERE assignee_id IS NOT NULL;

CREATE INDEX ix_tasks_updated_at
    ON tasks (updated_at DESC, id);

CREATE INDEX ix_task_labels_label_task
    ON task_labels (label_id, task_id);

