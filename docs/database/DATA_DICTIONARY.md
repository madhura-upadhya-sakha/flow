# Flow Application Data Dictionary

See the [Phase 2 schema proposal](DATABASE_DESIGN.md#phase-2-schema-proposal) for candidate relations and design decisions.

Types and nullability below match the PostgreSQL DDL. All `created_at` timestamps default to the transaction timestamp; `updated_at` also defaults on insert and must be refreshed by the application on update. `created_by` and `updated_by` are nullable to allow bootstrap/system operations. No password or token fields are stored.

## `workspaces`

One tenant/team scope for projects, members, and labels.

| Column | Type | Null | Default | Key / constraints | Meaning |
|---|---|---:|---|---|---|
| `id` | uuid | No | `gen_random_uuid()` | PK | Stable workspace ID |
| `name` | varchar(160) | No | — | Non-empty check | Workspace display name |
| `timezone` | varchar(64) | No | `'UTC'` | Non-empty check | IANA timezone name; validate in application |
| `created_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Creation time |
| `updated_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Last update time |
| `created_by` | uuid | Yes | — | FK → `users.id` | Creating actor, if known |
| `updated_by` | uuid | Yes | — | FK → `users.id` | Last updating actor, if known |

## `users`

Application person/profile record. Authentication credentials are deliberately out of scope.

| Column | Type | Null | Default | Key / constraints | Meaning |
|---|---|---:|---|---|---|
| `id` | uuid | No | `gen_random_uuid()` | PK | Stable user ID |
| `display_name` | varchar(160) | No | — | Non-empty check | Name shown in the UI |
| `email` | varchar(320) | No | — | Unique; non-empty check | Contact/identity email; normalize case in application |
| `avatar_url` | text | Yes | — | — | Optional profile image URI |
| `created_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Creation time |
| `updated_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Last update time |

## `workspace_members`

Junction representing workspace membership and a product-defined role.

| Column | Type | Null | Default | Key / constraints | Meaning |
|---|---|---:|---|---|---|
| `workspace_id` | uuid | No | — | PK part; FK → `workspaces.id` | Workspace joined |
| `user_id` | uuid | No | — | PK part; FK → `users.id` | Member |
| `role` | varchar(64) | No | — | Non-empty check | Workspace role; allowed values not specified |
| `employee_id` | text | No | Generated at insertion | Unique within the workspace | Stable employee identifier |
| `status` | text | No | `active` | `active`, `inactive`, or `pending_invitation` | Workspace access status |
| `display_name` | varchar(160) | Yes | — | — | Workspace display name override |
| `work_email` | varchar(320) | Yes | — | — | Workspace contact email override |
| `created_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Membership creation time |
| `updated_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Membership update time |
| `created_by` | uuid | Yes | — | FK → `users.id` | Actor who added member |
| `updated_by` | uuid | Yes | — | FK → `users.id` | Actor who last changed membership |

## `projects`

Workspace-owned project metadata and date window.

| Column | Type | Null | Default | Key / constraints | Meaning |
|---|---|---:|---|---|---|
| `id` | uuid | No | `gen_random_uuid()` | PK | Stable project ID |
| `workspace_id` | uuid | No | — | FK → `workspaces.id`; unique pair with `id` | Owning workspace |
| `name` | varchar(200) | No | — | Non-empty check | Project name |
| `description` | text | Yes | — | — | Optional project description |
| `status` | varchar(64) | No | — | Non-empty check | Project lifecycle state; values not specified |
| `start_date` | date | Yes | — | `start_date <= due_date` when both set | Optional planned start |
| `due_date` | date | Yes | — | Date-range check | Optional planned completion date |
| `owner_id` | uuid | Yes | — | Composite FK with `workspace_id` → `workspace_members(workspace_id, user_id)` | Optional owner; must be a workspace member |
| `created_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Creation time |
| `updated_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Last update time |
| `created_by` | uuid | Yes | — | FK → `users.id` | Creating actor |
| `updated_by` | uuid | Yes | — | FK → `users.id` | Last updating actor |

## `project_members`

Junction representing project membership; no per-project role is included because none is specified.

| Column | Type | Null | Default | Key / constraints | Meaning |
|---|---|---:|---|---|---|
| `project_id` | uuid | No | — | PK part; FK → `projects.id` | Project joined |
| `user_id` | uuid | No | — | PK part; FK → `users.id` | Project member |
| `workspace_id` | uuid | No | — | Composite FKs to project and workspace membership | Repeated tenant key ensuring project members belong to the same workspace |
| `created_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Membership creation time |
| `updated_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Membership update time |
| `created_by` | uuid | Yes | — | FK → `users.id` | Actor who added member |
| `updated_by` | uuid | Yes | — | FK → `users.id` | Actor who last changed membership |

## `tasks`

Project work item shown in board, timeline, and dashboard task panels.

| Column | Type | Null | Default | Key / constraints | Meaning |
|---|---|---:|---|---|---|
| `id` | uuid | No | `gen_random_uuid()` | PK | Stable task ID |
| `project_id` | uuid | No | — | FK → `projects.id` | Parent project |
| `workspace_id` | uuid | No | — | Composite FK with `project_id` → `projects(id, workspace_id)` | Repeated tenant key used to prevent cross-workspace references |
| `title` | varchar(240) | No | — | Non-empty check | Short task name |
| `description` | text | Yes | — | — | Optional task details |
| `status` | varchar(64) | No | — | Non-empty check | Workflow state; allowed values/transitions not specified |
| `priority` | varchar(64) | Yes | — | Non-empty if set | Optional priority; vocabulary not specified |
| `assignee_id` | uuid | Yes | — | FK → `users.id` | Optional assigned user |
| `start_date` | date | Yes | — | On or before `due_date` when both are set | Optional scheduled start |
| `due_date` | date | Yes | — | On or after `start_date` when both are set | Optional target date |
| `created_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Creation time |
| `updated_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Last update time |
| `created_by` | uuid | Yes | — | FK → `users.id` | Creating actor |
| `updated_by` | uuid | Yes | — | FK → `users.id` | Last updating actor |

## `labels`

Reusable label vocabulary scoped to one workspace.

| Column | Type | Null | Default | Key / constraints | Meaning |
|---|---|---:|---|---|---|
| `id` | uuid | No | `gen_random_uuid()` | PK | Stable label ID |
| `workspace_id` | uuid | No | — | FK → `workspaces.id`; unique pair with `id` | Owning workspace |
| `name` | varchar(80) | No | — | Unique with `workspace_id`; non-empty check | Label text |
| `created_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Creation time |
| `updated_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Last update time |
| `created_by` | uuid | Yes | — | FK → `users.id` | Creating actor |
| `updated_by` | uuid | Yes | — | FK → `users.id` | Last updating actor |

## `task_labels`

Junction assigning workspace labels to tasks. Composite key prevents duplicate assignment.

| Column | Type | Null | Default | Key / constraints | Meaning |
|---|---|---:|---|---|---|
| `task_id` | uuid | No | — | PK part; FK → `tasks.id` | Tagged task |
| `label_id` | uuid | No | — | PK part; FK → `labels.id` | Applied label |
| `workspace_id` | uuid | No | — | Composite FKs with `task_id` and `label_id` | Shared workspace for both associated records |
| `created_at` | timestamptz | No | `CURRENT_TIMESTAMP` | — | Assignment creation time |

The DDL additionally enforces same-workspace project/task and task/label association using composite foreign keys. Foreign-key columns are indexed where needed for joins and delete checks; see `database/indexes.sql`.

## Workspace operations

- `workspace_departments.lead_id` references an optional lead in the same workspace. Membership records can reference a department, manager, and job title. Department and manager references are scoped to the workspace. The reporting API checks for cycles.
- `workspace_role_permissions` stores the permission preview for each workspace role key, including custom roles. Names are unique within each workspace without regard to case.
- `workspace_audit` stores timestamped workspace administration events, including the actor, module, action, affected record, and changed fields. The audit API also includes task activity and import history.
- `task_imports` stores the upload file name, row-level errors, and skipped count in addition to the imported task count. A workbook may span several projects, so its job does not require a single project ID.
