-- Migration 0080: hash password-reset and email-verification tokens at rest
-- ([Pen test] Auth & session mgmt weekly review, 2026-08-24 — Monday theme;
-- finding OPS-20 in docs/OPSEC-REVIEW-2026-08-24.md).
--
-- Prior gap: `password_reset_tokens.token` and
-- `email_verification_tokens.token` stored the raw bearer token. Agent-API
-- PATs have been SHA-256'd at rest since they were introduced
-- (db/shared/api-credentials.ts), and docs/OPSEC.md lists D5 "bearer tokens in
-- circulation" as hashed on that basis — but these two tables were the
-- exception. A read-only copy of the reset table (a Neon snapshot, a branch, a
-- support query, a backup, a replica) was a 24-hour account-takeover
-- credential for every reset in flight: the holder needs no password, no
-- mailbox access, and leaves no trace beyond a normal-looking reset.
--
-- Shape: add a nullable `token_hash` and make `token` nullable. From this
-- change on, routes write `token = NULL, token_hash = sha256hex(token)` and
-- look up by hash. Rows minted BEFORE this deploy keep their plaintext and a
-- NULL hash, and the routes match them with an explicit
-- `token_hash IS NULL AND token = ?` arm so links already in someone's inbox
-- keep working through the rollover.
--
-- FOLLOW-UP (safe once the rollover window has passed — 24h for resets, 7d for
-- verification): drop the plaintext arm from the four lookups in
-- auth-worker/src/routes/auth.ts, then
--   ALTER TABLE password_reset_tokens DROP COLUMN token;
--   ALTER TABLE email_verification_tokens DROP COLUMN token;
--
-- Apply by hand against Neon (same convention as prior migrations in this
-- directory — NOT applied automatically):
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0080_auth_token_hashing.sql
-- Verify: both tables have a `token_hash` column with a UNIQUE index, and
-- `token` is nullable.

ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE password_reset_tokens ALTER COLUMN token DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_hash
    ON password_reset_tokens(token_hash);

ALTER TABLE email_verification_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE email_verification_tokens ALTER COLUMN token DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_verification_tokens_hash
    ON email_verification_tokens(token_hash);
