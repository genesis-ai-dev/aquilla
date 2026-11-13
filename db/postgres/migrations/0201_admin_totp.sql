-- AQU-2553: factors are isolated from copied production data by deployment name.
CREATE TABLE IF NOT EXISTS admin_totp (
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
 PRIMARY KEY(user_id, deployment)
);
ALTER TABLE admin_elevations ADD COLUMN IF NOT EXISTS factor_generation TEXT;
CREATE TABLE IF NOT EXISTS admin_totp_attempts (
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 deployment TEXT NOT NULL,
 started_at TIMESTAMPTZ NOT NULL,
 attempts INTEGER NOT NULL,
 PRIMARY KEY(user_id,deployment)
);
