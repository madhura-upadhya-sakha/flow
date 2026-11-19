BEGIN;

ALTER TABLE task_activity
    ADD COLUMN previous_values jsonb,
    ADD COLUMN updated_values jsonb,
    ADD COLUMN source text;
ALTER TABLE task_activity ALTER COLUMN source SET DEFAULT
    CASE WHEN current_setting('application_name') = 'flowdeck-api' THEN 'Flowdeck web application' END;

ALTER TABLE workspace_audit
    ADD COLUMN previous_values jsonb,
    ADD COLUMN updated_values jsonb,
    ADD COLUMN source text;
ALTER TABLE workspace_audit ALTER COLUMN source SET DEFAULT
    CASE WHEN current_setting('application_name') = 'flowdeck-api' THEN 'Flowdeck web application' END;

CREATE FUNCTION flow_task_audit_values(item tasks, fields text[]) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT jsonb_object_agg(field, CASE field
        WHEN 'Title' THEN to_jsonb(item.title)
        WHEN 'Description' THEN to_jsonb(item.description)
        WHEN 'Project' THEN to_jsonb((SELECT name FROM projects WHERE id = item.project_id AND workspace_id = item.workspace_id))
        WHEN 'Assignee' THEN to_jsonb((SELECT display_name FROM users WHERE id = item.assignee_id))
        WHEN 'Priority' THEN to_jsonb(item.priority)
        WHEN 'Status' THEN to_jsonb(item.status)
        WHEN 'Start date' THEN to_jsonb(item.start_date)
        WHEN 'Due date' THEN to_jsonb(item.due_date)
        WHEN 'Estimate' THEN to_jsonb(item.estimate_minutes)
        WHEN 'Approval' THEN to_jsonb(item.approval)
        WHEN 'Blocking dependency' THEN to_jsonb((SELECT title FROM tasks WHERE id = item.blocking_task_id AND workspace_id = item.workspace_id))
    END)
    FROM unnest(fields) AS field;
$$;

CREATE OR REPLACE FUNCTION flow_record_task_activity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    changed text[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO task_activity (workspace_id, task_id, actor_id, action, updated_values)
        VALUES (NEW.workspace_id, NEW.id, NEW.created_by, 'created', flow_task_audit_values(NEW, ARRAY['Title', 'Status']));
        RETURN NEW;
    END IF;

    changed := array_remove(ARRAY[
        CASE WHEN NEW.title IS DISTINCT FROM OLD.title THEN 'Title' END,
        CASE WHEN NEW.description IS DISTINCT FROM OLD.description THEN 'Description' END,
        CASE WHEN NEW.project_id IS DISTINCT FROM OLD.project_id THEN 'Project' END,
        CASE WHEN NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN 'Assignee' END,
        CASE WHEN NEW.priority IS DISTINCT FROM OLD.priority THEN 'Priority' END,
        CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN 'Status' END,
        CASE WHEN NEW.start_date IS DISTINCT FROM OLD.start_date THEN 'Start date' END,
        CASE WHEN NEW.due_date IS DISTINCT FROM OLD.due_date THEN 'Due date' END,
        CASE WHEN NEW.estimate_minutes IS DISTINCT FROM OLD.estimate_minutes THEN 'Estimate' END,
        CASE WHEN NEW.approval IS DISTINCT FROM OLD.approval THEN 'Approval' END,
        CASE WHEN NEW.blocking_task_id IS DISTINCT FROM OLD.blocking_task_id THEN 'Blocking dependency' END
    ], NULL);

    IF cardinality(changed) > 0 THEN
        INSERT INTO task_activity (workspace_id, task_id, actor_id, action, changed_fields, status_after, previous_values, updated_values)
        VALUES (NEW.workspace_id, NEW.id, NEW.updated_by, 'updated', changed, CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN NEW.status END,
            flow_task_audit_values(OLD, changed), flow_task_audit_values(NEW, changed));
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION flow_record_workspace_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    previous jsonb;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        previous := jsonb_build_object('Role', OLD.role);
    END IF;

    INSERT INTO workspace_audit (workspace_id, actor_id, module, action, record, fields, previous_values, updated_values)
    SELECT NEW.workspace_id, COALESCE(NEW.updated_by, NEW.created_by), 'User',
        CASE WHEN TG_OP = 'INSERT' THEN 'Added' ELSE 'Assigned' END, display_name, ARRAY[NEW.role],
        previous, jsonb_build_object('Role', NEW.role)
    FROM users WHERE id = NEW.user_id;
    RETURN NEW;
END;
$$;

CREATE VIEW workspace_audit_events AS
    SELECT workspace_id, id, actor_id, action, module, record, created_at, fields,
        COALESCE(source, 'Workspace audit') AS source, previous_values, updated_values
    FROM workspace_audit
    UNION ALL
    SELECT a.workspace_id, a.id, a.actor_id, initcap(a.action), 'Task', t.title, a.created_at, a.changed_fields,
        COALESCE(a.source, 'Task activity'), a.previous_values,
        COALESCE(a.updated_values, CASE WHEN a.status_after IS NOT NULL THEN jsonb_build_object('Status', a.status_after) END)
    FROM task_activity a JOIN tasks t ON (t.workspace_id, t.id) = (a.workspace_id, a.task_id)
    UNION ALL
    SELECT workspace_id, id, actor_id, 'Imported', 'Import', COALESCE(file_name, project_name), created_at,
        ARRAY[task_count || ' imported'], 'Task import', NULL::jsonb,
        jsonb_build_object('Imported', task_count, 'Failed', jsonb_array_length(errors), 'Skipped', skipped_count)
    FROM task_imports;

COMMIT;
