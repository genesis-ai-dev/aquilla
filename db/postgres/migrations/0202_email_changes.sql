-- AQU-957: destination proof is hashed, short-lived and bound to an account generation.
CREATE TABLE email_change_requests (
 user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 old_email TEXT NOT NULL,
 new_email TEXT NOT NULL,
 session_version INTEGER NOT NULL,
 token_hash TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL
);
