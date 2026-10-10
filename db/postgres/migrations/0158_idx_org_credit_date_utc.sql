-- 0158_idx_org_credit_date_utc.sql — AQU-1869
--
-- The platform AI spend ceiling (db/shared/ai-spend-ceiling.ts) sums
-- `raw_cost_cents` for ONE UTC day across ALL orgs before every paid AI call.
-- The only index on this table is `idx_org_credit_org_date (org_id, date_utc)`,
-- which a query with no org predicate cannot use, so that sum was a sequential
-- scan of the whole ledger. The guard caches its read for 15 s in-isolate, but
-- the table grows by one row per (org, user, day, rail) forever, so the scan
-- gets steadily more expensive while the answer stays one number.
--
-- Keep this file a SINGLE statement: CONCURRENTLY cannot run in a transaction
-- and the migration runner sends the file as one query.
--
-- Additive and idempotent. A database loaded from schema.sql already has it.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_org_credit_date
  ON org_credit_usage_daily (date_utc);
