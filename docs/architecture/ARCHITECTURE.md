# Application architecture

Flow is organized as an npm-workspaces monorepo:

- `apps/web`: React, TypeScript, and Vite UI. It owns routing, presentation, accessibility, and browser authentication setup.
- `apps/api`: NestJS REST API. It owns token verification, authorization, request validation, business rules, and persistence.
- `packages/contracts`: transport/domain TypeScript types shared between the web and API.
- `database`: PostgreSQL clean-database setup scripts and database design documents.

Auth0 issues identity/access tokens. The API validates access-token signature, issuer, audience, and expiry. Flow workspace membership remains the data-access authority: API feature services must resolve the authenticated subject to a Flow user and verify membership for every workspace-scoped query. Never authorize a request from a client-supplied workspace ID alone.

The current implementation stage includes the dashboard UI, PostgreSQL connection pool, Auth0 provider/guard scaffolding, and public health check. Feature API routes, DB repositories, user identity synchronization, workspace authorization, and Auth0 login controls are not implemented yet.
