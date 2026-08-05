-- Migration 0073: server-side logout / token revocation ([Pen test] Auth &
-- session mgmt weekly review, 2026-08-03 — Monday theme).
--
-- Prior gap: there was no POST /api/v2/auth/logout route at all. The
-- frontend's "logout" only deleted the token client-side (session-store.ts);
-- a stolen access token (30-day default lifetime, ACCESS_TOKEN_EXPIRE_MINUTES)
-- kept authenticating for up to 30 more days after the user logged out,
-- unless they separately reset their password (which invalidates via
-- users.password_changed_at, migration 0066 — a different, coarser lever).
--
-- revoked_tokens is a denylist keyed by JWT `jti` (added to every newly
-- minted access token by JWTService.createAccessToken). POST /auth/logout
-- inserts the caller's own jti; authMiddleware rejects any token whose jti
-- is present. expires_at mirrors the token's own `exp` so rows can be pruned
-- once the token would have expired naturally anyway — the denylist never
-- needs to outlive the thing it's denying.
--
-- Apply by hand against Neon (same convention as prior migrations in this
-- directory — NOT applied automatically):
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0073_auth_logout_revocation.sql
-- Verify: `revoked_tokens` exists with the `idx_revoked_tokens_expires_at` index.

CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti        TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at ON revoked_tokens(expires_at);
