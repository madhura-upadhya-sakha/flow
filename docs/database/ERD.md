# Flow Application ERD

See the [Phase 2 schema proposal](DATABASE_DESIGN.md#phase-2-schema-proposal) for candidate relations and design decisions.

This Mermaid ERD reflects the baseline tables in `database/schema.sql`. It does not include optional activity events, authentication credentials, or cached dashboard aggregates.

```mermaid
erDiagram
    WORKSPACES ||--o{ WORKSPACE_MEMBERS : has
    USERS ||--o{ WORKSPACE_MEMBERS : joins
    WORKSPACES ||--o{ PROJECTS : contains
    WORKSPACE_MEMBERS o|--o{ PROJECTS : owns
    PROJECTS ||--o{ PROJECT_MEMBERS : has
    USERS ||--o{ PROJECT_MEMBERS : joins
    PROJECTS ||--o{ TASKS : contains
    USERS o|--o{ TASKS : assigned
    WORKSPACES ||--o{ LABELS : defines
    TASKS ||--o{ TASK_LABELS : tagged
    LABELS ||--o{ TASK_LABELS : applied
    USERS o|--o{ WORKSPACES : creates_or_updates
    USERS o|--o{ PROJECTS : creates_or_updates
    USERS o|--o{ TASKS : creates_or_updates

    WORKSPACES {
        uuid id PK
        varchar name
        varchar timezone
        timestamptz created_at
        timestamptz updated_at
        uuid created_by FK
        uuid updated_by FK
    }
    USERS {
        uuid id PK
        varchar display_name
        varchar email UK
        text avatar_url
        timestamptz created_at
        timestamptz updated_at
    }
    WORKSPACE_MEMBERS {
        uuid workspace_id PK,FK
        uuid user_id PK,FK
        varchar role
        timestamptz created_at
        timestamptz updated_at
        uuid created_by FK
        uuid updated_by FK
    }
    PROJECTS {
        uuid id PK
        uuid workspace_id FK
        varchar name
        text description
        varchar status
        date start_date
        date due_date
        uuid owner_id FK
        timestamptz created_at
        timestamptz updated_at
        uuid created_by FK
        uuid updated_by FK
    }
    PROJECT_MEMBERS {
        uuid project_id PK,FK
        uuid user_id PK,FK
        uuid workspace_id FK
        timestamptz created_at
        timestamptz updated_at
        uuid created_by FK
        uuid updated_by FK
    }
    TASKS {
        uuid id PK
        uuid project_id FK
        uuid workspace_id FK
        varchar title
        text description
        varchar status
        varchar priority
        uuid assignee_id FK
        date due_date
        timestamptz created_at
        timestamptz updated_at
        uuid created_by FK
        uuid updated_by FK
    }
    LABELS {
        uuid id PK
        uuid workspace_id FK
        varchar name
        timestamptz created_at
        timestamptz updated_at
        uuid created_by FK
        uuid updated_by FK
    }
    TASK_LABELS {
        uuid task_id PK,FK
        uuid label_id PK,FK
        uuid workspace_id FK
        timestamptz created_at
    }
```

Membership and label junctions have composite primary keys. Foreign-key delete behavior is restrictive; see `database/constraints.sql` for exact definitions.
