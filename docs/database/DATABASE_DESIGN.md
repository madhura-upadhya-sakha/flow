# Flow Application — Database Design

## 1. Scope and source alignment

This design uses the supplied `TECH_SPEC.md` as its only confirmed requirements source. The spec describes a project-management dashboard and names workspace, user, project, task, and optional activity data. It also proposes project membership and task labels. It explicitly says the Figma Make source could not be inspected, so exact workflows, status values, roles, retention, and activity-feed requirements are unverified.

This design does not add authentication credentials, comments, attachments, notifications, billing, or workflow configuration because the technical specification does not require them. Dashboard counts and summaries are derived from persisted rows; they are not separate tables. Activity events are excluded from the baseline schema because the UI presence is uncertain; see open questions.

## 2. Database recommendation

**Recommended engine: PostgreSQL 18.x**, using the latest available minor release in the selected environment. PostgreSQL 18 is supported by the PostgreSQL project through November 14, 2030; its stable relational constraints, transactions, UUID support, date/time types, and mature indexing make it suitable for workspace-scoped project and task data. The schema uses portable features available in PostgreSQL 16+, so deployments on supported PostgreSQL 16 or 17 can use it after confirming driver/tool compatibility. Pin a supported major version and apply minor security/bug-fix releases regularly. See the [official PostgreSQL version policy](https://www.postgresql.org/support/versioning/) and [UUID type documentation](https://www.postgresql.org/docs/current/datatype-uuid.html).

Alternatives considered: MySQL is a viable relational option but would require syntax and constraint review; SQLite is useful for local prototypes but is not the recommended multi-user production store; document databases are a weaker fit for the many-to-many membership/label relationships and referential integrity described here. No measured workload or hosting constraint was provided, so this is a requirements-based recommendation, not a benchmark conclusion.

## 3. Conventions and modeling decisions

- Use lowercase `snake_case` table and column names; plural table names.
- Use application-generated or PostgreSQL-generated UUID primary keys. Scripts default UUIDs with `gen_random_uuid()`; supported PostgreSQL versions provide UUID generation.
- Store timestamps as `timestamptz` in UTC. Store business dates such as due dates as `date` because the spec models them as calendar dates.
- Keep status and role values as constrained non-empty text, not enums, until product workflows define a canonical value set. This avoids encoding invented states.
- Use explicit junction tables for workspace membership, project membership, and task labels.
- Use `ON DELETE RESTRICT` for business relationships. Deletion/archival/retention policy is not specified; hard deletion must not silently cascade through project data.
- Add `created_at`, `updated_at`, `created_by`, and `updated_by` audit fields to mutable core entities. The application must set actor fields and update `updated_at` on every mutation; SQL defaults only cover initial timestamps.
- Do not store passwords or authentication secrets in these tables. Identity provider integration is outside the documented scope.
- `labels` are normalized from the spec's task `labels` field into workspace-scoped label records and a junction table. If labels are merely presentation strings and not managed/reused, revisit this model.
- `workspace_members` and `project_members` make the spec's workspace/project scope and `memberIds` explicit. Their access semantics and role vocabulary remain open.
- `tasks.workspace_id` and `task_labels.workspace_id` repeat tenant scope to enforce composite foreign keys and prevent cross-workspace project/label associations. This is intentional, constraint-backed denormalization.

## 4. Entity inventory

| Entity / table | Purpose | Key | Important relationships |
|---|---|---|---|
| `workspaces` | Tenant/team scope for dashboard data | `id` | Has members, projects, labels |
| `users` | Person records referenced as owners, members, assignees, and audit actors | `id` | Joins workspaces and projects |
| `workspace_members` | User membership and workspace role | (`workspace_id`, `user_id`) | Joins workspace to user; constrains project owners and project members to workspace |
| `projects` | Project metadata, date window, status, owner | `id` | Belongs to workspace; has members and tasks |
| `project_members` | User membership in a project | (`project_id`, `user_id`) | Joins project to user |
| `tasks` | Work item with status, priority, assignee, due date | `id` | Belongs to project; optional assignee; has labels |
| `labels` | Reusable workspace-scoped task label | `id` | Belongs to workspace; joins tasks through `task_labels` |
| `task_labels` | Task-to-label association | (`task_id`, `label_id`) | Junction for the many-to-many task/label relation |

The owner, assignee, creator, and updater are nullable where a record can be unassigned or system-created. Project owners and project members must be workspace members by composite FK. Task assignee scope remains an application rule until product requirements confirm whether assignees must be workspace/project members. Workspace/project membership roles are required text but their allowed values are intentionally not enumerated pending product clarification.

## 5. Physical schema

The authoritative executable definitions are in `database/schema.sql`, `constraints.sql`, and `indexes.sql`. The schema script creates tables in dependency order and leaves cross-table constraints and secondary indexes to their dedicated scripts.

| Table | Column | Data type | PK | FK | Nullable | Default | Description |
|---|---|---|---|---|---|---|---|
| workspaces | id | uuid | Yes | — | No | `gen_random_uuid()` | Workspace identifier |
| workspaces | name | varchar(160) | — | — | No | — | Display name |
| workspaces | timezone | varchar(64) | — | — | No | `'UTC'` | IANA timezone identifier; validate in application |
| workspaces | created_at, updated_at | timestamptz | — | — | No | `CURRENT_TIMESTAMP` | Audit timestamps |
| workspaces | created_by, updated_by | uuid | — | users.id | Yes | — | Audit actor; nullable for bootstrap/system writes |
| users | id | uuid | Yes | — | No | `gen_random_uuid()` | User identifier |
| users | display_name | varchar(160) | — | — | No | — | Display name |
| users | email | varchar(320) | — | — | No | — | Login/contact identifier; normalized by application |
| users | avatar_url | text | — | — | Yes | — | Optional avatar URI |
| users | created_at, updated_at | timestamptz | — | — | No | `CURRENT_TIMESTAMP` | Audit timestamps |
| workspace_members | workspace_id | uuid | Yes | workspaces.id | No | — | Workspace membership scope |
| workspace_members | user_id | uuid | Yes | users.id | No | — | Member user |
| workspace_members | role | varchar(64) | — | — | No | — | Product-defined workspace role; values pending |
| workspace_members | created_at, updated_at | timestamptz | — | — | No | `CURRENT_TIMESTAMP` | Membership audit timestamps |
| workspace_members | created_by, updated_by | uuid | — | users.id | Yes | — | Audit actor |
| projects | id | uuid | Yes | — | No | `gen_random_uuid()` | Project identifier |
| projects | workspace_id | uuid | — | workspaces.id | No | — | Owning workspace |
| projects | name | varchar(200) | — | — | No | — | Project name |
| projects | description | text | — | — | Yes | — | Optional project description |
| projects | status | varchar(64) | — | — | No | — | Product-defined project status; values pending |
| projects | start_date, due_date | date | — | — | Yes | — | Optional project date range |
| projects | owner_id | uuid | — | workspace_members.user_id with workspace_id | Yes | — | Optional project owner; must be a workspace member |
| projects | created_at, updated_at | timestamptz | — | — | No | `CURRENT_TIMESTAMP` | Audit timestamps |
| projects | created_by, updated_by | uuid | — | users.id | Yes | — | Audit actor |
| project_members | project_id | uuid | Yes | projects.id | No | — | Project membership scope |
| project_members | user_id | uuid | Yes | users.id | No | — | Member user |
| project_members | workspace_id | uuid | — | projects.workspace_id and workspace_members.workspace_id | No | — | Tenant key checked by composite foreign keys; member must belong to workspace |
| project_members | created_at, updated_at | timestamptz | — | — | No | `CURRENT_TIMESTAMP` | Membership audit timestamps |
| project_members | created_by, updated_by | uuid | — | users.id | Yes | — | Audit actor |
| tasks | id | uuid | Yes | — | No | `gen_random_uuid()` | Task identifier |
| tasks | project_id | uuid | — | projects.id | No | — | Parent project |
| tasks | workspace_id | uuid | — | projects.workspace_id | No | — | Repeated tenant key checked with project_id by composite foreign key |
| tasks | title | varchar(240) | — | — | No | — | Task title |
| tasks | description | text | — | — | Yes | — | Optional task details |
| tasks | status | varchar(64) | — | — | No | — | Product-defined task status; values pending |
| tasks | priority | varchar(64) | — | — | Yes | — | Optional product-defined priority |
| tasks | assignee_id | uuid | — | users.id | Yes | — | Optional assignee |
| tasks | due_date | date | — | — | Yes | — | Optional due date |
| tasks | created_at, updated_at | timestamptz | — | — | No | `CURRENT_TIMESTAMP` | Audit timestamps |
| tasks | created_by, updated_by | uuid | — | users.id | Yes | — | Audit actor |
| labels | id | uuid | Yes | — | No | `gen_random_uuid()` | Label identifier |
| labels | workspace_id | uuid | — | workspaces.id | No | — | Owning workspace |
| labels | name | varchar(80) | — | — | No | — | Workspace label name |
| labels | created_at, updated_at | timestamptz | — | — | No | `CURRENT_TIMESTAMP` | Audit timestamps |
| labels | created_by, updated_by | uuid | — | users.id | Yes | — | Audit actor |
| task_labels | task_id | uuid | Yes | tasks.id | No | — | Associated task |
| task_labels | label_id | uuid | Yes | labels.id | No | — | Associated label |
| task_labels | workspace_id | uuid | — | tasks.workspace_id and labels.workspace_id | No | — | Tenant key checked by both composite foreign keys |
| task_labels | created_at | timestamptz | — | — | No | `CURRENT_TIMESTAMP` | Association creation time |

Each table also has the named table-level unique/check/foreign-key constraints declared in SQL. All schema columns and constraint names use the same spelling as these scripts.

## 6. Relationships and cardinality

| Relationship | Cardinality | Implementation |
|---|---|---|
| Workspace → workspace members | 1:N | `workspace_members.workspace_id` |
| User → workspace memberships | 1:N | `workspace_members.user_id` |
| Workspace ↔ users | M:N | `workspace_members` junction |
| Workspace → projects | 1:N | `projects.workspace_id` |
| Project ↔ users | M:N | `project_members` junction |
| Project → tasks | 1:N | `tasks.project_id` |
| User → assigned tasks | 1:N, optional on task | `tasks.assignee_id` |
| Workspace → labels | 1:N | `labels.workspace_id` |
| Task ↔ labels | M:N | `task_labels` junction |
| User → audit-created/updated records | 1:N, optional actor | `created_by` / `updated_by` references |

No one-to-one relation or recursive parent-child task hierarchy is supported by the requirements. Cascade deletion is deliberately absent. ORM implementations should use lazy collection loading by default, explicit fetch joins/projections for dashboard reads, and no bidirectional serialization of entity graphs. Cascade only transient child creation where the persistence framework semantics are understood; do not cascade remove across business entities.

## 7. Normalization and integrity

- **1NF:** Each scalar field contains one value; labels and membership lists use junction tables.
- **2NF:** Junction-table attributes depend on the full composite key. Other tables have single-column primary keys.
- **3NF:** Workspace, user, project, task, and label facts are stored once in their owning tables. Counts and dashboard summaries are derived, avoiding duplicated aggregates.
- **Intentional denormalization:** `tasks.workspace_id` and `task_labels.workspace_id` duplicate a derivable tenant key so composite FKs can prevent cross-workspace project/label associations. This is constraint-backed. No dashboard aggregates are stored; if volume later requires cached aggregates, treat them as rebuildable projections with documented refresh and consistency behavior.
- **Referential integrity:** FKs use restrictive delete behavior. Composite unique keys support workspace scoping and prevent cross-workspace project-label associations.
- **Transactions:** Create a project and initial memberships/tasks in one transaction when the UI action is atomic. Task updates and label association changes should commit atomically. Enforce concurrent uniqueness and integrity in SQL, not only application code.

## 8. Audit, privacy, and access

Passwords and authentication tokens must remain in an identity provider or a separate appropriately protected credential system; they are absent here. Email and avatar URLs are personal data and should be returned only to authorized workspace users. Apply least-privilege database roles: migrations, application read/write, and reporting access should be separate. All application queries must authorize the active workspace and membership; UUIDs are identifiers, not access controls.

Audit timestamps are database-defaulted on insert; the application updates `updated_at` and `updated_by` on modification. Audit actor IDs can be null for system/bootstrap writes. No soft-delete column is included because retention, restore, and uniqueness behavior were not specified. If soft delete is required, define `deleted_at`, restore rules, query filters, and uniqueness semantics before adding it.

## 9. Index and query plan

Primary keys and unique constraints create indexes. `indexes.sql` adds only indexes supporting expected joins and workspace dashboard filters: membership reverse lookups, project listing by workspace/status and due date, task listing by project/status/due date and assignee, and label association reverse lookups. Validate with real query plans and representative data before adding further indexes. Use keyset/cursor pagination for large task/project lists; stable sort should include `id` as a tie-breaker. Avoid offset pagination for deep pages.

## 10. Traceability and gaps

| Requirement or workflow in `TECH_SPEC.md` | Schema support | Gap / note |
|---|---|---|
| Workspace/user-scoped dashboard | `workspaces`, `users`, `workspace_members` | Authentication and exact authorization policy unspecified |
| Project listing and project summaries | `projects`, `project_members`, `tasks` | Aggregate counts should be derived; exact filters unknown |
| Project owner and members | `projects.owner_id`, `project_members` | Role/owner membership rules need product decision |
| Board/task workflow and task status | `tasks` | Canonical statuses and allowed transitions unspecified |
| Assignees | `tasks.assignee_id` | Whether assignee must be a project member is not specified |
| Due dates/upcoming tasks | `projects.due_date`, `tasks.due_date` | Timezone/date semantics to confirm; dates stored as calendar dates |
| Task labels | `labels`, `task_labels` | Label colors, uniqueness/case-folding, and lifecycle unspecified |
| Team page | `users`, `workspace_members` | Invitation lifecycle and profile fields unspecified |
| Activity feed (conditional in spec) | Not implemented | Add `activity_events` only if the UI/product requires persistent history |
| Search, filter, sorting, pagination | Indexes on project/task fields | Search semantics and text-search needs unknown |
| Create/update with audit | Audit columns on core entities | No immutable audit history; only latest creator/updater retained |
| Loading/empty/error states | No persistence impact | API behavior and error contract are application concerns |
| Mobile/responsive behavior and a11y | No persistence impact | UI concerns, not representable in this schema |

No required dashboard workflow in the available specification is impossible to represent, but activity history, immutable change history, authentication, invitations, and workflow state transitions are not fully supported because their requirements are not established.

## 11. Assumptions and questions requiring product confirmation

1. A workspace is the tenant boundary and users may belong to multiple workspaces.
2. Projects belong to exactly one workspace. Project owners and project members must be workspace members. Project members are users, not external guests.
3. Labels are reusable per workspace and unique by exact name within a workspace; case-insensitive uniqueness may be preferable.
4. Project/task status and task priority values remain open text vocabularies until product rules are confirmed.
5. Workspace timezone defaults to UTC; whether deadlines are date-only or instant-based needs confirmation.
6. Activity feed visibility and immutable audit/event retention are unknown.
7. Deletion, archival, restore, data retention, invitations, and membership role permissions are not specified.
8. The Make source files and actual dashboard screenshot were not accessible through the current MCP path, so the design has not been reconciled with implementation code.

## 12. Execution order

On a clean PostgreSQL database, execute in order: `database/schema.sql`, `database/constraints.sql`, `database/indexes.sql`, then the SQL files in `database/migrations/` in numeric order. Scripts are intentionally unqualified by schema and assume the target schema is on `search_path`. Run them with a migration tool in deployed environments; these development scripts are not an idempotent migration framework.

## Phase 2 schema proposal

The updated Figma Make inventory lists account, user administration, roles, organization, audit, notifications, task import, and AI assistant screens. Review the [Phase 2 specification](../../TECH_SPEC.md#phase-2-design-scope) for the source files and outstanding decisions.

| Candidate relation | Keys and scope | Decisions needed before migration |
|---|---|---|
| `user_identities` | Unique `(issuer, subject)` mapped to `users.id` | Confirm account provisioning, linking, and how existing users get an identity mapping. |
| `roles`, `role_permissions`, `workspace_member_roles` | Scope role assignments to `workspace_members`. Require both membership and role to belong to the same workspace. | Confirm built-in and editable roles, permission keys, and single or multiple assignments. |
| `organizations` | Link workspaces to an organization only if the design establishes an organization above the workspace. | Confirm tenant boundary and organization settings. |
| `audit_events` | Append-only events scoped by workspace, with actor, action, target and event time. | Confirm event catalog, actor handling after deletion, visibility, and retention. |
| `notifications` | Scope each record to a workspace and recipient. Consider `read_at` if read state is supported. | Confirm triggers, delivery channels and recipient history behavior. |
| `task_imports`, `task_import_rows` | Scope each run to a workspace and initiating user. Relate each row result to its run and any created task. | Confirm validation, retry behavior, duplicate handling, upload retention, and atomicity. |
| Assistant persistence | Apply workspace and actor scope to any stored conversation or action. | Confirm whether the screen stores history or executes actions before adding tables. |

Preserve existing workspace, project, and task IDs. For role migration, inventory existing `workspace_members.role` values and review their mapping before backfilling assignments. During rollout, deploy compatible reads and writes before removing the legacy role column. Record any required audit events in the same transaction as the successful operation they describe. Add indexes for the confirmed query patterns, such as workspace and event time for audit history, or recipient and creation time for notifications. Verify upgrades against an existing database and confirm that database constraints and API checks reject cross-workspace access.

The current SQL files describe the baseline database. This proposal records candidate relationships while feature behavior and migration rules are awaiting confirmation.
