BEGIN;

CREATE SEQUENCE workspace_employee_number_seq START 1001;
ALTER TABLE workspace_members
    ADD COLUMN display_name varchar(160),
    ADD COLUMN work_email varchar(320),
    ADD COLUMN employee_id text,
    ADD COLUMN status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'pending_invitation'));

CREATE FUNCTION flow_employee_id(workspace uuid) RETURNS text LANGUAGE sql VOLATILE AS $$
    SELECT COALESCE(NULLIF(upper(left(regexp_replace(name, '[^[:alnum:]]', '', 'g'), 2)), ''), 'EMP')
        || '-' || nextval('workspace_employee_number_seq')
    FROM workspaces WHERE id = workspace;
$$;

UPDATE workspace_members SET employee_id = flow_employee_id(workspace_id);
ALTER TABLE workspace_members ALTER COLUMN employee_id SET NOT NULL,
    ADD UNIQUE (workspace_id, employee_id);

CREATE FUNCTION flow_assign_employee_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.employee_id IS NULL THEN
        NEW.employee_id := flow_employee_id(NEW.workspace_id);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_member_employee_id BEFORE INSERT ON workspace_members
    FOR EACH ROW EXECUTE FUNCTION flow_assign_employee_id();

CREATE VIEW workspace_people AS
    SELECT m.*, COALESCE(m.display_name, u.display_name) AS name, COALESCE(m.work_email, u.email) AS email
    FROM workspace_members m JOIN users u ON u.id = m.user_id;

CREATE OR REPLACE FUNCTION flow_record_workspace_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    person text;
BEGIN
    SELECT COALESCE(NEW.display_name, display_name) INTO person FROM users WHERE id = NEW.user_id;
    IF TG_OP = 'INSERT' THEN
        INSERT INTO workspace_audit (workspace_id, actor_id, module, action, record, fields, updated_values)
        VALUES (NEW.workspace_id, COALESCE(NEW.updated_by, NEW.created_by), 'User',
            CASE WHEN NEW.status = 'pending_invitation' THEN 'Invited' ELSE 'Added' END, person, ARRAY[NEW.role],
            jsonb_build_object('Role', NEW.role, 'Status', NEW.status));
    ELSE
        IF NEW.role IS DISTINCT FROM OLD.role THEN
            INSERT INTO workspace_audit (workspace_id, actor_id, module, action, record, fields, previous_values, updated_values)
            VALUES (NEW.workspace_id, NEW.updated_by, 'User', 'Assigned', person, ARRAY[NEW.role],
                jsonb_build_object('Role', OLD.role), jsonb_build_object('Role', NEW.role));
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            INSERT INTO workspace_audit (workspace_id, actor_id, module, action, record, fields, previous_values, updated_values)
            VALUES (NEW.workspace_id, NEW.updated_by, 'User', CASE NEW.status
                WHEN 'active' THEN 'Activated' WHEN 'inactive' THEN 'Deactivated' ELSE 'Invited' END, person, ARRAY['Status'],
                jsonb_build_object('Status', OLD.status), jsonb_build_object('Status', NEW.status));
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER workspace_members_role_changed ON workspace_members;
CREATE TRIGGER workspace_members_access_changed AFTER UPDATE OF role, status ON workspace_members
    FOR EACH ROW WHEN (NEW.role IS DISTINCT FROM OLD.role OR NEW.status IS DISTINCT FROM OLD.status)
    EXECUTE FUNCTION flow_record_workspace_membership();

COMMIT;
