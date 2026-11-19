BEGIN;

ALTER TABLE workspace_departments
    ADD CONSTRAINT uq_workspace_departments_id UNIQUE (workspace_id, id),
    ADD COLUMN lead_id uuid,
    ADD CONSTRAINT fk_department_lead FOREIGN KEY (workspace_id, lead_id)
        REFERENCES workspace_members(workspace_id, user_id) ON DELETE SET NULL (lead_id);

ALTER TABLE workspace_members
    ADD COLUMN department_id uuid,
    ADD COLUMN manager_id uuid,
    ADD COLUMN job_title varchar(120),
    ADD CONSTRAINT fk_member_department FOREIGN KEY (workspace_id, department_id)
        REFERENCES workspace_departments(workspace_id, id) ON DELETE SET NULL (department_id),
    ADD CONSTRAINT fk_member_manager FOREIGN KEY (workspace_id, manager_id)
        REFERENCES workspace_members(workspace_id, user_id) ON DELETE SET NULL (manager_id),
    ADD CONSTRAINT ck_member_not_own_manager CHECK (manager_id IS DISTINCT FROM user_id);

CREATE TABLE workspace_role_permissions (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key text NOT NULL,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
    permissions text[] NOT NULL,
    PRIMARY KEY (workspace_id, key)
);
CREATE UNIQUE INDEX uq_workspace_role_name ON workspace_role_permissions (workspace_id, lower(name));

CREATE TABLE workspace_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    module text NOT NULL,
    action text NOT NULL,
    record text NOT NULL,
    fields text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX workspace_audit_recent_idx ON workspace_audit(workspace_id, created_at DESC, id DESC);

CREATE FUNCTION flow_record_workspace_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_audit (workspace_id, actor_id, module, action, record, fields)
    SELECT NEW.workspace_id, COALESCE(NEW.updated_by, NEW.created_by), 'User',
        CASE WHEN TG_OP = 'INSERT' THEN 'Added' ELSE 'Assigned' END, display_name, ARRAY[NEW.role]
    FROM users WHERE id = NEW.user_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_members_added AFTER INSERT ON workspace_members
    FOR EACH ROW EXECUTE FUNCTION flow_record_workspace_membership();
CREATE TRIGGER workspace_members_role_changed AFTER UPDATE OF role ON workspace_members
    FOR EACH ROW WHEN (NEW.role IS DISTINCT FROM OLD.role) EXECUTE FUNCTION flow_record_workspace_membership();

ALTER TABLE task_imports ALTER COLUMN project_id DROP NOT NULL,
    ADD COLUMN file_name text,
    ADD COLUMN errors jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0);

COMMIT;
