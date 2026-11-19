# API documentation

The API is a NestJS REST service mounted under `/api`.

| Method | Path | Access | Behavior |
|---|---|---|---|
| GET | `/api/health` | Public | Checks PostgreSQL connectivity and returns 503 if unavailable |
| GET | `/api/dashboard` | Local workspace | Lists workspace projects, tasks, and members |
| GET | `/api/dashboard/projects/:id/overview` | Local workspace | Returns the selected project’s owner, dates, logged minutes, contributors, and recent task activity |
| POST | `/api/dashboard/projects` | Local workspace | Creates a project and adds its creator as a project member |
| PATCH, DELETE | `/api/dashboard/projects/:id` | Local workspace | Updates or deletes a project |
| GET, PATCH | `/api/dashboard/tasks/:id/details` | Local workspace | Returns drawer fields, counts, labels, time totals, links and subtasks. PATCH updates one editable property per request. |
| POST | `/api/dashboard/tasks/:id/subtasks` | Local workspace | Creates a subtask from a title and client-generated `requestId` |
| POST | `/api/dashboard/tasks/:id/attachments` | Local workspace | Uploads one multipart file (1 byte to 5 MB) using the `file` field |
| GET | `/api/dashboard/tasks/:id/attachments/:fileId` | Local workspace | Downloads an attachment as a file. The request is scoped to the task and workspace. |
| POST | `/api/dashboard/tasks/:id/attachment-links` | Local workspace | Attaches an HTTP or HTTPS URL to the task |
| GET, POST | `/api/dashboard/tasks/:id/comments` | Local workspace | Lists task comments newest first with an optional cursor. POST takes a comment body and a client-generated UUID `requestId` for safe retries. |
| GET | `/api/dashboard/board-cards` | Local workspace | Returns labels and comment and subtask counts for board cards. Optional `projectId` limits the response to a project in the workspace. |
| PATCH | `/api/dashboard/tasks/:id/board-position` | Local workspace | Moves or reorders a Kanban task. Requires the original task status and position and the destination column order. Returns 409 for stale moves. |
| GET | `/api/dashboard/tasks/:id/activity` | Local workspace | Lists persisted task events newest first with an optional cursor |
| POST | `/api/dashboard/tasks` | Local workspace | Creates a task. An optional `requestId` makes retries safe. |
| PATCH, DELETE | `/api/dashboard/tasks/:id` | Local workspace | Updates or deletes a task. PATCH also accepts a boolean `done` field to update completion. |
| POST | `/api/dashboard/imports/preview` | Local workspace | Validates CSV and returns row-level feedback without writing tasks |
| POST | `/api/dashboard/imports` | Local workspace | Imports a valid CSV atomically. Requires a UUID `requestId` for safe retries. |
| GET | `/api/dashboard/imports` | Local workspace | Lists completed imports with an optional cursor |
| GET | `/api/dashboard/administration/:section` | Local workspace owner or admin | Returns read-only organization details, departments, role assignments, or recent task activity |
| GET | `/api/dashboard/overview` | Local workspace | Returns seven daily completion counts, last week’s total, and current-week logged minutes using the workspace timezone |
| GET | `/api/dashboard/unread-notifications` | Local workspace | Returns the signed-in workspace member’s unread count |
| POST | `/api/dashboard/tasks/:id/time-entries` | Local workspace | Logs 1–1440 whole minutes for the current member. Requires a UUID `requestId` for safe retries. |
| GET | `/api/dashboard/workspace-panels` | Local workspace | Returns the five latest task events and current-week capacity totals |
| PATCH | `/api/dashboard/members/:id/weekly-capacity` | Local workspace owner or admin | Sets a member’s weekly capacity in whole minutes |
| GET | `/api/dashboard/team-workload` | Local workspace | Returns open, overdue, and completed task counts per workspace member |
| GET | `/api/dashboard/members/:id` | Local workspace | Returns a workspace member’s name, email, role, and join date |
| GET | `/api/dashboard/members` | Local workspace | Lists member IDs, names, email addresses, and workspace roles |
| POST | `/api/dashboard/members` | Local workspace | Creates or reuses a user and adds workspace membership |

The dashboard routes require a loopback request and a configured local workspace member. They are disabled in production.

## Phase 2 integration

The [technical specification](../../TECH_SPEC.md#phase-2-design-scope) records the Figma Make feature inventory. The [database design](../database/DATABASE_DESIGN.md#phase-2-schema-proposal) identifies candidate storage and migration decisions. Before defining Phase 2 endpoints, confirm the prototype's actions, payload fields, and permission matrix. Resolve the authenticated identity and workspace membership before any workspace query or mutation. Verify that members cannot read or modify data outside their workspace.

## Notifications

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/notifications/workspaces` | Lists memberships for the verified Auth0 identity |
| GET | `/api/notifications` | Returns `items`, workspace inbox `unreadCount`, and `nextCursor`. Accepts optional `type`, `unread=true`, `cursor`, and `limit` (1–25). The header inbox requests the three most recent items. |
| PATCH | `/api/notifications/:id/read` | Marks a recipient-owned item read. An already-read item keeps its timestamp. |
| POST | `/api/notifications/read-all` | Marks the recipient's unread items in the selected workspace read |
| GET, PATCH | `/api/notification-preferences` | Reads or updates boolean in-app settings for `assignment`, `deadline`, `comment`, and `membership`. Unset options default to enabled. |

Production requests require Auth0 bearer tokens and an approved mapping in `user_identities` from the verified issuer (with trailing slash) and subject to a Flow user. The browser selects a workspace from verified memberships and sends `X-Workspace-Id`. The API rechecks membership on each operation. Local development can reuse the dashboard's configured loopback identity.

Fresh Docker PostgreSQL installations apply [the notification migration](../../database/migrations/001_notifications.sql) during initialization. For an existing database, apply the migration SQL with the configured database client before opening the inbox. The migration adds the inbox, preferences, and identity mapping. It also records events for task assignments, task status changes, task deadline changes, and additions to project membership. Updates that repeat an existing value do not create a second event.

The [task comment migration](../../database/migrations/002_task_comments.sql) adds comment storage and notifies the task assignee when someone else comments and the assignee has comment notifications enabled. Apply it after the notifications migration. The current deadline event records changes to a task's due date. Scheduled reminders and email delivery are outside this implementation.

To verify against local PostgreSQL after applying the migration, run `npm run build` followed by `node --env-file=apps/api/.env apps/api/test/integration/notifications.cjs` from the monorepo root. The test creates temporary fixtures and removes them after it runs.

Apply [the board and activity migration](../../database/migrations/003_task_board_and_activity.sql) after the task-comments migration. Existing tasks sort by due date until moved. The activity feed starts recording new events at migration time.

## Task imports

Apply the [task imports migration](../../database/migrations/004_task_imports.sql) after the board and activity migration. Both POST endpoints accept `projectId` and UTF-8 `csv` text. Files are limited to 32 KiB and 100 task rows. Use `title` as a header. Optional headers are `description`, `status`, `priority`, `due_date` and `assignee_email`. Invalid rows return the source line and an error. The submit endpoint revalidates the CSV and rejects the whole batch if a row is invalid. The completed import history stores counts and a source digest.

Apply the [dashboard metrics migration](../../database/migrations/005_dashboard_metrics.sql) after the task imports migration. The momentum chart counts completion events recorded after migration. Logged time is counted from saved task time entries.

Apply the [workspace administration migration](../../database/migrations/006_workspace_administration.sql) after the dashboard metrics migration. The dashboard selects an active sprint from the current workspace and calculates remaining days using its time zone. If no sprint is active, the card is hidden. Production role and permission configuration is outside the local administration views.

Apply the [workspace panels migration](../../database/migrations/007_workspace_panels.sql) after workspace administration. Weekly capacity defaults to 40 hours per member and can be changed from Team workload. Assigned capacity sums estimates on tasks assigned to workspace members and due between Monday and Sunday in the workspace time zone. Existing tasks start without estimates. Recent activity uses recorded task events and displays the task title as the link.

Apply the [task details migration](../../database/migrations/008_task_details.sql) after the workspace panels migration. Task dependencies and subtasks are scoped to their workspace. Attachment links store a name and URL.

Apply the [task creation requests migration](../../database/migrations/009_task_creation_requests.sql) after task details. Retrying the same task creation request returns the existing task. Reusing that request ID with different details returns 409.

Apply the [task attachment files migration](../../database/migrations/010_task_attachment_files.sql) after task creation requests. File summaries include their size in bytes. Uploading identical content with the same name to the same task returns the existing attachment.

Apply the [task schedule migration](../../database/migrations/011_task_schedule.sql) after task attachment files. Dashboard task records include `startDate` and `createdAt`. Task creation and editing accept an optional `startDate` in `YYYY-MM-DD` format. An edit that omits `startDate` preserves it, and an explicit null or empty string clears it. The task details endpoint also returns `startDate` and accepts it as a single-property update. PostgreSQL rejects a start date after the due date, and the API returns HTTP 400 for invalid ranges.

Apply the [workspace operations migration](../../database/migrations/012_workspace_operations.sql) after task scheduling.

- `GET /api/dashboard/team-workload` accepts an optional workspace project ID as `projectId`. Weekly assigned minutes sum estimates for tasks due Monday through Sunday in the workspace time zone. Logged minutes use the active sprint or the current week.
- Workspace administrators can create and update departments, assign reporting relationships through `PATCH /api/dashboard/administration/reporting/:id`, and create, duplicate, or edit permission previews through `/api/dashboard/administration/roles`. Preview changes are stored in PostgreSQL. Live authorization continues to use the current workspace membership roles.
- `GET /api/dashboard/administration/audit` supports `search`, `module`, inclusive calendar dates `from` and `to`, and a `cursor`. It includes workspace administration changes, task activity, and imports.
- Excel uploads read the first worksheet and send up to 100 mapped rows to the existing import preview and submit endpoints as `{ fileName, requestId, rows, allowPartial }`. Each populated row needs a task title and a project name or ID from the active workspace. Submit revalidates the rows and saves valid tasks, failures, and skipped counts atomically. Invalid rows can be excluded from an Excel import after preview. History entries expose an error CSV at `GET /api/dashboard/imports/:id/report`. Existing CSV imports keep their all-or-nothing validation.
- Notifications lists include per-type totals for the recipient and workspace alongside `unreadCount`.

Apply the [audit detail migration](../../database/migrations/013_audit_details.sql) after workspace operations. Workspace administrators can read the source and saved change values for a single event at `GET /api/dashboard/administration/audit/:id`. A null value map means the event has no saved snapshot for that side of the comparison. Earlier task events can still expose the updated status when it was recorded.

### User management

Apply the [workspace users migration](../../database/migrations/014_workspace_users.sql) after audit details. Existing workspace members start as active and receive a stable employee ID.

- `GET /api/dashboard/administration/users` returns summary counts and five users per page. It accepts `search`, `department`, `status`, `sort`, and `page`.
- `GET /api/dashboard/administration/users/options` returns department, role, and manager choices. `GET /api/dashboard/administration/users/:id` includes the user's workload and project assignments. Active members can read their own profile.
- Administrators can create and edit workspace profiles through the same collection and detail routes using POST and PATCH. Profile contact details are specific to the workspace. Owners manage administrator access, and the API protects the owner's membership and the caller's own access. Custom application roles are displayed on the profile and retain the permission preview behavior.
- Saving an invitation creates a pending workspace membership. This flow does not send email. Inactive and pending memberships cannot access the workspace. Role, status, and profile changes appear in the workspace audit log.

### My profile

`GET /api/account/profile` returns the current user's workspace display name, work email, access role, status, active projects, and open tasks. `PATCH /api/account/profile` accepts only `name` and `email` and records profile changes in workspace audit history. Both routes require an active membership. Auth0 clients send a bearer token and select their workspace through `X-Workspace-Id`. Local development can use the configured loopback identity.

Sign-in passwords and Auth0 sign-out remain with the identity provider. The local demo uses a browser-tab session without a password.
