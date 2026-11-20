CREATE TABLE IF NOT EXISTS user_passwords (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash text NOT NULL
);

CREATE TABLE IF NOT EXISTS password_sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES user_passwords(user_id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS password_sessions_user_idx ON password_sessions(user_id);
CREATE INDEX IF NOT EXISTS password_sessions_expiry_idx ON password_sessions(expires_at);
