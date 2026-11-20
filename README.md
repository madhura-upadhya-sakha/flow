# Flow

Flow is a TypeScript monorepo for the project-management dashboard described in [`TECH_SPEC.md`](./TECH_SPEC.md). The design URL currently resolves to Figma Make source links, but this environment cannot read their contents or render a Make screenshot. The web app is based on the available requirements and is not pixel-verified against Figma.

## Repository layout

```text
flow/
├── apps/
│   ├── web/                         # React + TypeScript + Vite dashboard
│   │   ├── src/
│   │   │   ├── components/layout/   # App shell and workspace navigation
│   │   │   ├── features/dashboard/  # Dashboard, summary, project, task UI
│   │   │   ├── lib/                 # Icon primitives and client utilities
│   │   │   └── styles/              # Responsive styling and design tokens
│   │   └── tests/unit/              # UI unit tests
│   └── api/                         # NestJS + TypeScript REST API
│       ├── src/
│       │   ├── auth/                # Auth0 JWT/JWKS guard
│       │   ├── common/              # Cross-cutting decorators, filters, pipes
│       │   ├── dashboard/           # Dashboard query feature module
│       │   ├── database/            # PostgreSQL pool and connection lifecycle
│       │   ├── health/              # Public service/database health endpoint
│       │   ├── projects/            # Project and membership feature module
│       │   ├── tasks/               # Task feature module
│       │   ├── users/               # User profile feature module
│       │   └── workspaces/          # Workspace and authorization feature module
│       └── test/                    # API unit and integration tests
├── packages/contracts/              # Shared API/domain TypeScript types
├── database/                        # PostgreSQL schema, constraints, indexes, seed
├── docs/database/                   # Database design, ERD, and data dictionary
└── infra/postgres/                  # Local PostgreSQL Docker Compose service
```

## Start locally

Requirements: Node.js 20.19+ and Docker Compose. From this directory:

```bash
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
docker compose -f infra/postgres/docker-compose.yml up -d
npm install
npm run dev
```

The web client is served at `http://localhost:5173/dashboard`; the API health endpoint is `http://localhost:3000/api/health`. The first PostgreSQL container startup applies the SQL files mounted from `database/`; the scripts are clean-database initialization scripts.

For a local database-backed dashboard, set `LOCAL_DASHBOARD_WORKSPACE_ID` and `LOCAL_DASHBOARD_USER_ID` in `apps/api/.env` to an existing `workspace_members` pair. The database initialization scripts create the tables. Add a workspace, user, and workspace membership before setting those IDs. With local dashboard access configured, the API binds to loopback and the dashboard can load projects, tasks, and team counts, create projects, and update task completion.

Database initialization starts with empty tables. After configuring the local workspace and owner, open Projects and create the first project for testing.

Local demo access is disabled in production and when `AUTH0_ISSUER` is set to an Auth0 tenant. The dashboard uses the signed-in user's active workspace membership in Auth0 mode. Creating and deleting dashboard records requires the workspace owner or admin role. Authenticated users with the Projects & tasks Edit permission can also update existing projects and tasks. Changing task assignees requires Assign permission.

### Enable email and password sign-in

1. In Auth0, register a Single Page Application and enable a database connection. Use `http://localhost:5173` for Allowed Callback URLs and Allowed Web Origins, and `http://localhost:5173/signed-out` for Allowed Logout URLs.
2. Register an Auth0 API and use its identifier for both `VITE_AUTH0_AUDIENCE` in `apps/web/.env.local` and `AUTH0_AUDIENCE` in `apps/api/.env`. Set `VITE_AUTH0_DOMAIN` and `VITE_AUTH0_CLIENT_ID` to the SPA settings. Set `AUTH0_ISSUER` to the tenant URL, including `https://` and the trailing slash.
3. Create the user's credential account in Auth0. Add a row to `user_identities` with the tenant issuer, the Auth0 user ID as `subject`, and the existing Flow user's UUID as `user_id`. The Flow user must have an active workspace membership. Match the Auth0 user ID exactly, including its provider prefix.
4. Restart the web and API processes and open [Flow](http://localhost:5173/dashboard). Choose **Sign in**.

## Development commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start web and API workspaces together |
| `npm run dev:web` | Start only the Vite web client |
| `npm run dev:api` | Start only the NestJS API |
| `npm run build` | Build all workspaces that define a build script |
| `npm run typecheck` | Type-check all workspaces that define a typecheck script |

API modules follow a feature-first pattern. Add DTOs/controllers/services/repositories inside their feature directory and unit tests alongside the feature or under `apps/api/test`. Keep workspace authorization in the API and enforce it at repository-query boundaries. Do not treat a valid Auth0 identity or a client-supplied workspace ID as authorization by itself.

### Account actions

For Auth0 database accounts, set `VITE_AUTH0_DB_CONNECTION` to the database connection used by the application. Change password sends a reset email through Auth0. Add the deployed application's `/signed-out` URL to the Auth0 application's Allowed Logout URLs. With Auth0 absent, Logout exits the local workspace UI for the current tab and Change password explains that local demo users have no password to reset.

### Database-backed password sign-in

Use this mode for a workspace that should accept passwords directly in Flowdeck. Keep the Auth0 frontend settings unset when using this mode. Configure `PASSWORD_AUTH_WORKSPACE_ID` in `apps/api/.env` with the existing workspace UUID. Existing databases need [migration 015](database/migrations/015_password_sessions.sql) applied before enabling the mode.

From the repository root, build the API and set the password for an existing active user. Use the user's original account email.

```bash
npm run build --workspace @flow/api
read -r -s -p 'New Flowdeck password: ' flowdeck_password
printf '\n'
printf '%s\n' "$flowdeck_password" | node --env-file=apps/api/.env apps/api/scripts/set-password.cjs user@example.com
unset flowdeck_password
```

Set `DATABASE_AUTH_ENABLED=true` in `apps/api/.env`, restart the API, and open [Flowdeck login](http://localhost:5173/login). Sign out revokes the current session. A password change revokes all password sessions for that user and returns them to login. The password command also lets an administrator reset a forgotten password.
