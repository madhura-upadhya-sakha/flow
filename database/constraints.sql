-- Cross-table and domain integrity constraints.
-- Run after schema.sql and before indexes.sql.

ALTER TABLE users
    ADD CONSTRAINT uq_users_email UNIQUE (email),
    ADD CONSTRAINT ck_users_display_name_nonempty CHECK (length(btrim(display_name)) > 0),
    ADD CONSTRAINT ck_users_email_nonempty CHECK (length(btrim(email)) > 0);

ALTER TABLE workspaces
    ADD CONSTRAINT ck_workspaces_name_nonempty CHECK (length(btrim(name)) > 0),
    ADD CONSTRAINT ck_workspaces_timezone_nonempty CHECK (length(btrim(timezone)) > 0),
    ADD CONSTRAINT fk_workspaces_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_workspaces_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE workspace_members
    ADD CONSTRAINT fk_workspace_members_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_workspace_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_workspace_members_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_workspace_members_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT ck_workspace_members_role_nonempty CHECK (length(btrim(role)) > 0);

ALTER TABLE projects
    ADD CONSTRAINT fk_projects_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_projects_owner_workspace_member FOREIGN KEY (workspace_id, owner_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_projects_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_projects_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT ck_projects_name_nonempty CHECK (length(btrim(name)) > 0),
    ADD CONSTRAINT ck_projects_status_nonempty CHECK (length(btrim(status)) > 0),
    ADD CONSTRAINT ck_projects_date_range CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date);

ALTER TABLE project_members
    ADD CONSTRAINT fk_project_members_project_workspace FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_project_members_workspace_member FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_project_members_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_project_members_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE tasks
    ADD CONSTRAINT uq_tasks_id_workspace UNIQUE (id, workspace_id),
    ADD CONSTRAINT fk_tasks_project_workspace FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_tasks_assignee FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_tasks_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_tasks_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT ck_tasks_title_nonempty CHECK (length(btrim(title)) > 0),
    ADD CONSTRAINT ck_tasks_status_nonempty CHECK (length(btrim(status)) > 0),
    ADD CONSTRAINT ck_tasks_priority_nonempty CHECK (priority IS NULL OR length(btrim(priority)) > 0);

ALTER TABLE labels
    ADD CONSTRAINT fk_labels_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_labels_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_labels_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT ck_labels_name_nonempty CHECK (length(btrim(name)) > 0);

-- Composite keys ensure a label and task in different workspaces cannot be associated.
ALTER TABLE task_labels
    ADD CONSTRAINT fk_task_labels_task_workspace FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE RESTRICT,
    ADD CONSTRAINT fk_task_labels_label_workspace FOREIGN KEY (label_id, workspace_id) REFERENCES labels(id, workspace_id) ON DELETE RESTRICT;
