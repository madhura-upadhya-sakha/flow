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

The local dashboard endpoints are disabled in production. Auth0-backed dashboard access still requires user identity mapping and workspace authorization.

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
