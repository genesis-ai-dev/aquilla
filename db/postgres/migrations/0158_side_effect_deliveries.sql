-- 0158_side_effect_deliveries.sql — AQU-1824
--
-- The idempotency ledger behind the side-effect queue (sync-worker
-- src/side-effects/). One row per *delivery*: the smallest unit a queue
-- consumer can perform exactly once. For comment mail that unit is
-- (comment, recipient user), so a queue retry — or a duplicate delivery,
-- which Cloudflare Queues explicitly allows — never mails the same person
-- twice about the same comment.
--
-- `idempotency_key` is built by the producer, not the database, so the key is
-- stable across retries and across a redeploy: see sideEffectIdempotencyKey()
-- in sync-worker/src/side-effects/types.ts. Keys are namespaced by kind, so
-- the follow-up side effects this queue will carry (Monday nudges,
-- org-settings fan-out, link-notify) share the table without colliding.
--
-- Status is deliberately three-valued:
--   pending — claimed by a consumer, outcome unknown (first attempt in flight)
--   sent    — the side effect completed; never perform it again
--   failed  — the last attempt threw. Still retryable: the row records the
--             error for operators, and the queue's own retry/DLQ policy
--             (wrangler.toml max_retries + dead_letter_queue) decides when to
--             stop. A row left `failed` after the DLQ gives up is the audit
--             trail for mail that never went out.
--
-- A row stuck in `pending` is retried rather than skipped: the alternative
-- (treat ambiguity as "already sent") silently drops mail whenever a worker
-- dies mid-send, which is the exact failure this ticket exists to remove.
-- The cost is a possible duplicate in the narrow window where the provider
-- accepted the message but the status write did not land.
--
-- `created_at` is indexed for the pruning sweep (AQU-1843 tracks the cron):
-- the ledger only needs to outlive the queue's retry window.
--
-- Idempotent. A database loaded from schema.sql already has the table.

CREATE TABLE IF NOT EXISTS side_effect_deliveries (
    idempotency_key TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sent', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_side_effect_deliveries_created_at
    ON side_effect_deliveries (created_at);
