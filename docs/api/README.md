# API documentation

The API is a NestJS REST service mounted under `/api`.

## Implemented route

| Method | Path | Authentication | Behavior |
|---|---|---|---|
| `GET` | `/api/health` | Public | Checks that the service can query PostgreSQL; returns 503 if unavailable |

Dashboard, projects, tasks, users, and workspaces have module boundaries but no route handlers yet. Document each endpoint here when its DTO, authorization rule, persistence behavior, and response/error contract are implemented. All feature endpoints must enforce authenticated workspace membership server-side.
