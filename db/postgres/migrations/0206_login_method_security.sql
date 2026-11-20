-- AQU-2631: optional account settings protection; never a login requirement.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_login_disabled BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS account_security (
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 deployment TEXT NOT NULL,
 generation TEXT NOT NULL,
 secret_enc TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT false,
 setup_session TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 confirmed_step BIGINT,
 last_step BIGINT NOT NULL DEFAULT -1,
 recovery_hashes JSONB NOT NULL DEFAULT '[]',
 PRIMARY KEY(user_id,deployment)
);
CREATE TABLE IF NOT EXISTS account_security_grants (
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 deployment TEXT NOT NULL,
 session_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('primary','google','factor')),
 generation TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(user_id,deployment,session_key,kind)
);
CREATE TABLE IF NOT EXISTS account_security_attempts (
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 deployment TEXT NOT NULL,
 started_at TIMESTAMPTZ NOT NULL,
 attempts INTEGER NOT NULL,
 PRIMARY KEY(user_id,deployment)
);
