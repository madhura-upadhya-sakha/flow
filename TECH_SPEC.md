# Technical Specification: Project Management Dashboard

## Inspection scope and confidence

- **Target:** Figma Make file `3nsC0PrlltSIOg1o5Ty4m3`, preview route `/dashboard`; the Make context endpoint was called on its supported root node `0:1`.
- **Inspection result:** Figma returned source resource links for an app with `DashboardPage.tsx`, `AppShell.tsx`, shared task/UI components, project/board/team/timeline pages, state, data, and type files. The separate `get_screenshot` endpoint rejected the file because it does not support Figma Make. The returned `file://figma/make/...` resources could not be opened through the available MCP resource reader, and the provided preview URL was not accessible through the web reader.
- Consequently, this document distinguishes **known from resource names/URL** from **implementation recommendations/inferences**. Exact rendered layout, labels, token values, displayed records, and implemented interactions remain to be confirmed against the Make source or a screenshot. Do not treat inferred values below as pixel-accurate design facts.

## Phase 2 design scope

The updated Figma Make context exposes the following source files. The preview returned HTTP 403 and the connector could not open the linked source or project plan. Feature names below come from that inventory. The workflows and persistence model are proposals for review.

| Design files | Backend and data questions to resolve |
|---|---|
| `AuthPages.tsx`, `AccountPages.tsx`, `AuthContext.tsx`, `AccessDeniedPage.tsx` | Verify account flows. Resolve Auth0 users by issuer and subject before looking up workspace access. |
| `UsersPage.tsx`, `UserDetailPage.tsx`, `RolesPage.tsx`, `rbac.ts` | Confirm user lifecycle, role assignment scope, permission definitions, and which actions require each permission. |
| `OrganizationPage.tsx`, `PlatformContext.tsx` | Determine whether organization settings apply to an existing workspace or to an entity that owns multiple workspaces. |
| `AuditPage.tsx`, `NotificationsPage.tsx` | Confirm which actions produce audit events and notifications, who can see them, and whether the notifications have read state. |
| `ImportPage.tsx`, `ImportHistoryPage.tsx` | Confirm accepted formats, column mapping, validation, duplicate handling, and whether partial success is allowed. |
| `AIAssistantPage.tsx` | Confirm supported actions, data access, and whether conversations persist or can modify project data. |
| `RootLayout.tsx`, `routes.tsx`, `EnterpriseUI.tsx`, `AppShell.tsx` | Confirm route paths, navigation, access-denied states, and reusable UI before implementing. |

The repository already uses React/Vite, NestJS, PostgreSQL, and an Auth0 JWT guard. The dashboard API currently runs in local development under a configured workspace member. Phase 2 API wiring should resolve the authenticated user and workspace membership server-side, enforce permissions per operation, and use the same workspace scope in database queries and UI state. The proposed database relationships and migration sequence are in the [Phase 2 database design](docs/database/DATABASE_DESIGN.md#phase-2-schema-proposal).

## 1. Overview & Purpose

The target is the dashboard route of a project-management product called “Project Management Platform” (app source labels it “Flowdeck Project Management MVP”). Its likely primary goal is to give a signed-in team member an at-a-glance view of project and task progress and quick access to work management views. These outcomes are inferred from the product name and the source file inventory; exact dashboard content could not be verified.

The source inventory indicates a wider application with dashboard, projects, project overview, board, team, and timeline routes. The dashboard should act as the landing surface and provide navigation into those views. User identity, workspace, project membership, and permissions should scope all displayed data.

## Technologies Used

The following technologies are evident or reasonably inferred from the Figma Make source-file inventory. The source contents and `package.json` dependencies were not accessible during inspection, so exact versions and dependency details remain unverified.

| Technology | Evidence | Confidence / notes |
|---|---|---|
| Figma Make | The supplied design is a Figma Make file and returned application source resources | Confirmed as the design/prototyping environment; not necessarily a production runtime dependency |
| TypeScript | `tsconfig.json`, `vite.config.ts`, and TypeScript source files | Strongly indicated by project files |
| JSX / TSX UI components | `App.tsx`, `main.tsx`, and `.tsx` component/page files | Confirmed file format; React is the likely UI framework, but package metadata could not be inspected |
| React | `.tsx` application entry, component, and page naming | Likely; verify the `package.json` dependency before treating as confirmed |
| Vite | `vite.config.ts` | Strongly indicated as the build/dev tooling; version unknown |
| CSS | `src/index.css` | Confirmed stylesheet file; exact styling approach and token values unknown |
| Node.js / package manager | `package.json` and `vite.config.ts` | Expected for the likely Vite toolchain; runtime/package manager and versions were not readable |

No backend framework, API implementation, authentication provider, or database technology is confirmed by the accessible design context. The API shapes in this specification are proposals, not evidence of an existing service. Verify dependencies and runtime versions against `package.json` and the source files before implementation.

### Recommended backend, database, and authentication stack

The following stack is recommended for implementation; it is a proposal and is not confirmed as already present in the Figma Make source.

| Layer | Recommended technology | Rationale and implementation notes |
|---|---|---|
| Backend API | NestJS with TypeScript; REST API | Aligns with the likely TypeScript frontend and provides a structured server framework. Use request validation and authorization guards. |
| Relational database | PostgreSQL 18, latest supported minor release | Fits workspace-scoped project/task data, foreign-key integrity, and transactional updates. The PostgreSQL project supports major releases for five years; verify hosting and driver compatibility before rollout. |
| Identity and authentication | Auth0 using OpenID Connect (OIDC) | Use a browser authorization code flow with PKCE. Auth0 Organizations may represent customer organizations and their members if B2B organization management is needed. |

Auth0 should establish user identity; Flow's own workspace and membership records should remain authoritative for access to Flow data. The API must validate incoming access tokens and enforce workspace membership and permissions server-side for each request. Do not trust a client-supplied workspace ID as authorization, and do not store passwords in the Flow database. Confirm Auth0 plan capabilities, hosting support for PostgreSQL 18, and the selected OIDC SDKs before implementation.

## 2. Component Breakdown

### Known component/page inventory

| Component | Likely responsibility | Confidence / details to verify |
|---|---|---|
| `AppShell` | Shared application frame, navigation, page outlet | File exists; exact sidebar/header structure not inspectable |
| `DashboardPage` | Dashboard route content | File exists; exact cards, charts, tables, copy, and ordering unknown |
| Shared `UI` | Reusable controls and visual primitives | File exists; component exports and variants unknown |
| `TaskPanels` | Task-related panel(s) reused across views | File exists; panel contents and dashboard usage unknown |
| `ProjectsPage` | Project listing route | Route inferred from page filename |
| `ProjectOverviewPage` | Individual project summary route | Route inferred from page filename |
| `BoardPage` | Board/task workflow route | Route inferred from page filename |
| `TimelinePage` | Schedule/timeline route | Route inferred from page filename |
| `TeamPage` | Team/member route | Route inferred from page filename |

### Provisional hierarchy

```text
Application
└── AppShell
    ├── Global navigation (exact controls and placement unknown)
    └── DashboardPage (/dashboard)
        ├── Dashboard summary/content regions (unknown)
        └── Shared UI / task panels (usage unknown)
```

### Props contract (proposed; not recovered from source)

| Component | Proposed inputs | Notes |
|---|---|---|
| `AppShell` | `user`, `workspace`, `currentRoute`, `children` | Route selection and identity must reflect authorization state |
| `DashboardPage` | `summary`, `projects`, `tasks`, `activity`, `loading`, `error` | Keep fetched data separate from presentation |
| `TaskPanels` | `tasks`, `filters`, `onTaskSelect`, `onStatusChange` | Confirm supported actions against actual UI |
| `UI` primitives | `variant`, `size`, `disabled`, `loading`, accessible name | Exact names and API should follow existing source exports |

### Design system variables/tokens

The Figma Make source inventory includes `src/index.css` and `src/components/UI.tsx`, suggesting styles and shared primitives exist. Their contents were not retrievable, so **no specific color, font, spacing, radius, or shadow values can be stated as observed**. Developers should extract CSS custom properties, Tailwind/theme config (if present), and component defaults from those files before implementation; avoid introducing competing hard-coded values.

| Token category | Source to inspect | Specification status |
|---|---|---|
| Color (surface, text, border, accent, status) | `src/index.css`, `UI.tsx` | Values unknown; use existing variables |
| Typography (family, size, weight, line height) | `src/index.css`, `UI.tsx` | Values unknown |
| Spacing and layout | `src/index.css`, page components | Scale and breakpoints unknown |
| Radius, shadow, focus ring | `src/index.css`, `UI.tsx` | Values unknown |
| Icons and image assets | Make asset links / source imports | Four PNG assets were listed; use only after matching them to visible slots |

## 3. State & Edge Cases

### States to support

| State | Required behavior |
|---|---|
| Default | Render dashboard with the current workspace/user-scoped data and selected route/navigation state. |
| Hover | Provide visible hover feedback on interactive links, buttons, cards, and rows; hover must not be the only state cue. Exact design treatment is unknown. |
| Active/selected | Clearly identify the current navigation item and any selected filter/tab/date range. Keep selection synchronized with URL where appropriate. |
| Disabled | Disable actions unavailable by permission or current data; explain the reason accessibly where it is not obvious. |
| Loading | Show stable skeletons/placeholders per content region; prevent duplicate mutations and preserve shell/navigation. |
| Empty | Distinguish “no projects/tasks exist” from “no results match filters”; provide a relevant create/reset action only when authorized. |
| Error | Show a retryable inline error for failed dashboard queries; retain unaffected regions if requests fail independently. Avoid exposing internal error details. |
| Stale/offline | Identify stale data and allow retry; queue or clearly reject unsupported offline mutations. |
| Partial permissions | Omit or disable inaccessible actions and avoid leaking restricted project/team data. |
| Long content | Handle long project/task names, large member counts, and narrow viewports without overlap or inaccessible truncation. |

Only the default route is identified by the link. The hover, active, disabled, loading, empty, and error states above are implementation requirements, not states verified in the Make preview.

## 4. Functional & Interaction Logic

### Navigation and actions

| Interaction | Expected behavior | Status |
|---|---|---|
| Open `/dashboard` | Load dashboard within shared app shell; preserve/resolve workspace context | Route is supplied; exact behavior inferred |
| Select global navigation item | Navigate to projects, board, timeline, team, or project overview as available | Destinations indicated by source page filenames |
| Select project/task summary | Open the corresponding project overview or task detail/board location | Recommended; target affordance unverified |
| Search/filter/date controls | Apply filters, reflect selection in results, support clear/reset | Presence and exact controls unknown |
| Create/update actions | Validate input, check permission, send mutation, update UI on success, announce failures | Action set unknown |

### Validation and behavior

No dashboard form or visible action could be inspected. For any create/edit forms reachable from the dashboard, require trimmed non-empty names, enforce server-provided length limits, validate dates and status transitions, associate entities with an authorized workspace/project, and show field-level errors. Validate on submit and after correction; do not rely on client-side checks alone.

Use URL navigation for route-level changes so browser back/forward work. Preserve filter state in query parameters when it materially changes the view. Mutations should have pending, success, and failure feedback; prevent accidental duplicate submission. Confirm destructive operations and provide undo where feasible.

### Responsive behavior (recommendation)

Exact breakpoints and mobile composition are unknown. At desktop widths, preserve the app shell and use flexible content columns. At tablet/mobile widths, collapse global navigation into an accessible menu, stack dashboard regions, keep primary actions reachable, and allow dense tables/cards to reflow or scroll within a labeled region. Avoid page-level horizontal overflow. Support zoom and text enlargement without clipping controls.

## 5. Data & API Requirements

These are proposed models based on the project-management domain and source inventory (`data.ts`, `state.tsx`, `types.ts`); field names and actual endpoints must be reconciled with those source files. Use ISO-8601 timestamps and stable IDs. Every query must be tenant/workspace scoped and authorization checked server-side.

### Data fields

| Entity | Fields (proposed) | Purpose |
|---|---|---|
| Workspace | `id`, `name`, `timezone`, `createdAt` | Active team/workspace scope |
| User | `id`, `displayName`, `email`, `avatarUrl`, `role` | Current user and assignees |
| Project | `id`, `workspaceId`, `name`, `description`, `status`, `startDate`, `dueDate`, `ownerId`, `memberIds`, `taskCounts`, `updatedAt` | Project summary and progress |
| Task | `id`, `projectId`, `title`, `description`, `status`, `priority`, `assigneeId`, `dueDate`, `labels`, `createdAt`, `updatedAt` | Dashboard task list and workflow |
| Activity | `id`, `workspaceId`, `actorId`, `entityType`, `entityId`, `action`, `createdAt`, `metadata` | Recent activity, if present in UI |
| Dashboard summary | `workspaceId`, `generatedAt`, `projectCounts`, `taskCounts`, `overdueCount`, `upcomingItems` | Aggregate dashboard widgets, if present |

### Endpoint outline

| Method & path | Purpose | Query/body notes |
|---|---|---|
| `GET /api/workspaces/{workspaceId}/dashboard` | Fetch dashboard aggregates | Optional date range, project scope; return `generatedAt` |
| `GET /api/workspaces/{workspaceId}/projects` | List accessible projects | Pagination, search, status filters, sort |
| `GET /api/workspaces/{workspaceId}/tasks` | List tasks for dashboard | Filters for assignee/status/due date/project; pagination |
| `GET /api/workspaces/{workspaceId}/activity` | Fetch recent activity if required | Cursor pagination; return actor/entity summaries |
| `PATCH /api/tasks/{taskId}` | Update task fields if dashboard enables it | Validate field-level permissions and valid status transition |

Use a consistent error envelope (`code`, safe `message`, optional `fieldErrors`, `requestId`) and cursor/page metadata. Dashboard aggregates should be computed consistently with list data; document cache freshness and invalidate/refetch affected queries after mutations. Endpoint names are illustrative, not observed in the design.

## 6. Accessibility (a11y) Checklist

- Use semantic landmarks (`header`, `nav`, `main`) with a skip link to main content; give each route one clear page heading.
- Ensure all controls work by keyboard, have visible focus, and follow a logical order from global navigation into dashboard content. Support Escape for menus/dialogs and return focus to the trigger when overlays close.
- Provide accessible names for icon-only buttons (search, notifications, add, menu, profile, etc. only if present); use native buttons/links and do not add redundant ARIA to semantic elements.
- Mark current navigation with `aria-current="page"`; expose selected/expanded state for tabs, filters, and menus with appropriate semantics.
- Ensure normal text contrast meets WCAG 2.2 AA (4.5:1; 3:1 for large text) and non-text controls/focus indicators have at least 3:1 contrast against adjacent colors. Verify actual token combinations; none were available to measure.
- Do not use color alone for task status, priority, errors, or chart values. Include text labels and accessible chart summaries/data alternatives.
- Announce asynchronous loading/completion/error updates politely (for example `aria-live="polite"` for status); associate field errors with controls and set `aria-invalid` when applicable.
- Provide meaningful alt text for informative images and empty alt text for decorative assets. Respect reduced-motion preferences.
- On mobile, ensure menus and scrollable tables are keyboard reachable, touch targets are comfortably sized, and zoom does not hide essential actions.

## 7. Unit Test Plan (UI and Backend)

The cases below cover features and states documented in this specification. The Make source could not be inspected, so UI cases tied to unverified controls (search, filters, cards, task actions, activity, menus) are conditional: implement them only if those controls exist in the actual screen. These are unit tests; database engine behavior, HTTP wiring, and full browser behavior require separate integration or end-to-end tests.

### Test tooling (proposed)

| Area | Suggested tools | Notes |
|---|---|---|
| UI | Jest, React Testing Library, `@testing-library/user-event` | Confirm React and package versions from the project before adopting. Assert user-visible behavior rather than component internals. |
| NestJS services/guards | Jest with `@nestjs/testing` | Mock repositories, identity provider/JWKS adapter, and external services. Keep domain rules independently testable. |
| Coverage | Jest coverage reports | Set thresholds after a baseline; prioritize authorization, validation, and state/error branches over a blanket percentage. |

### UI unit cases

| ID | Feature/component | Test case / expected result |
|---|---|---|
| UI-01 | App shell | Renders the page outlet and primary navigation; current route is marked selected and uses `aria-current="page"`. |
| UI-02 | Navigation | Selecting each rendered route link calls the router with the correct destination; browser back/forward route state is reflected. |
| UI-03 | Dashboard default | Given populated dashboard props, renders the provided summary/project/task content without inventing or duplicating records. |
| UI-04 | Dashboard loading | Loading state exposes a status/skeleton region and does not show stale content as current. |
| UI-05 | Dashboard error | Error state gives a useful retry action; retry invokes the reload callback once and exposes an accessible error message. |
| UI-06 | Empty states | No-data state differs from filter-no-results state; create/reset actions appear only when their callbacks/permissions are supplied. |
| UI-07 | Summary/project navigation | Activating a project summary navigates to its project route with the correct project ID. Conditional on this affordance existing. |
| UI-08 | Task panels/list | Renders task title, status, due date, and assignee safely when optional values are absent; selecting a task invokes the correct callback. Conditional on rendered task rows/panels. |
| UI-09 | Task status action | A permitted status change calls the handler once with task ID and next status; disabled/pending controls cannot submit duplicates. Conditional on inline status actions. |
| UI-10 | Search/filter controls | Search and filters update controlled values, combine correctly, and clear/reset to the unfiltered state. Conditional on controls existing. |
| UI-11 | Filter URL state | Applying a shareable filter updates query parameters; loading with query parameters restores selected filters. Conditional on URL-persisted filters. |
| UI-12 | Form validation | Blank/whitespace-only names and malformed date ranges show field errors; corrected values clear errors and submit once. Conditional on forms in scope. |
| UI-13 | Permission states | Unauthorized actions are hidden or disabled as specified; no mutation callback fires on activation. |
| UI-14 | Pending mutation | Submit action enters pending state, prevents repeat submission, and restores interaction after success or failure. |
| UI-15 | Mutation feedback | Success and failure are announced via an accessible status; field errors are associated with inputs and set `aria-invalid`. |
| UI-16 | Long content | Long project/task names do not cause controls to overlap; accessible names retain the full text if visual truncation is used. |
| UI-17 | Keyboard interaction | Navigation and controls are operable in logical tab order; menu/dialog Escape behavior and focus restoration work where overlays exist. |
| UI-18 | Responsive composition | At configured breakpoints, navigation menu open/close and content stacking/overflow behavior match the responsive component contract. Use DOM/layout-independent assertions for component units; verify actual viewport geometry separately. |
| UI-19 | Accessible labels | Icon-only buttons have accessible names; decorative images are ignored by assistive technology and informative images have alt text. |
| UI-20 | Reduced motion | Motion-dependent UI respects the reduced-motion preference where animation is implemented. |

### Backend unit cases

| ID | Service/guard | Test case / expected result |
|---|---|---|
| API-01 | Access token guard | Accepts a valid authenticated principal; rejects missing, expired, invalid-signature, wrong-issuer, or wrong-audience credentials with unauthorized result. Mock token verification rather than calling Auth0. |
| API-02 | Workspace authorization | Allows a member with required permission; denies non-member, wrong-workspace, and insufficient-role requests. Verify the workspace ID is derived/checked server-side. |
| API-03 | Dashboard query service | Aggregates projects/tasks and overdue/upcoming counts from repository results; empty inputs return zero/empty values with the expected workspace ID. |
| API-04 | Dashboard isolation | Repository calls are always scoped by authorized workspace ID; records from another workspace cannot affect the result. |
| API-05 | Project list service | Applies workspace, status, search, sorting, and pagination criteria; returns stable cursor metadata. Test absent and malformed optional filters. |
| API-06 | Task list service | Applies project, assignee, status, due-date, and pagination filters; combines filters without widening workspace scope. |
| API-07 | Activity service | If activity is adopted, returns only workspace-scoped events in cursor order and handles empty results. Otherwise no activity endpoint is required. |
| API-08 | Task update service | Accepts only allowed fields, validates field lengths/date values/status transitions, scopes the task to authorized workspace, and stamps `updated_at`/`updated_by`. |
| API-09 | Task update rejection | Rejects unknown task, wrong workspace, missing permission, invalid transition, empty title/status, and malformed values without calling persistence save. |
| API-10 | Project creation/update service | If supported, validates trimmed names/date range, confirms owner/members are workspace members, and records audit actor. |
| API-11 | Membership service | Prevents duplicate workspace/project membership and rejects project membership for a user outside the project workspace. |
| API-12 | Label service | Enforces workspace-scoped label name uniqueness and rejects task-label association across workspaces. |
| API-13 | Error mapping | Maps validation, unauthorized, forbidden, not-found, conflict, and unexpected repository errors to the documented safe error envelope; does not expose stack traces/secrets. |
| API-14 | Pagination | Cursor parsing rejects invalid cursors; next-page ordering is stable with ID tie-breaker and does not repeat/skip rows in mocked repository contract. |
| API-15 | Audit behavior | User-triggered writes persist the authenticated actor and update timestamp; system/bootstrap writes may leave actor fields null. |
| API-16 | Data privacy | User responses omit credential/token fields; unauthorized workspace data is never included in result DTOs. |

### Data-integrity validation outside unit tests

The SQL constraints in the database scripts cannot be proven by mocked service unit tests. Add PostgreSQL integration tests that execute the DDL and verify: FK rejection on missing parents; workspace boundary rejection for project owners, project members, tasks, and task-label links; uniqueness of email, workspace label name, and junction pairs; non-empty text/date-range checks; and restrictive delete behavior. API contract tests should separately verify HTTP status codes, serialization, and authentication middleware wiring. Browser end-to-end tests should verify actual responsive layout, keyboard focus, and accessibility-tree behavior.

## Implementation handoff

Before treating this as a pixel-level specification, retrieve the linked Make source resources or provide an accessible screenshot of `/dashboard`. Confirm the actual component tree, text/content, CSS variables, route wiring, and responsive states against `DashboardPage.tsx`, `AppShell.tsx`, `UI.tsx`, `index.css`, `data.ts`, `state.tsx`, and `types.ts`. Replace the explicitly inferred contracts above with source-backed details once available.
