-- FRO-265: AI budget counters
-- One row per (user_id, UTC date). user_id=0 is the global aggregate sentinel.
-- Upserted on every proxied AI request; checked against per-user and global
-- daily limits before forwarding to OpenRouter.

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  user_id       INTEGER     NOT NULL,
  date_utc      DATE        NOT NULL,
  request_count INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date_utc)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_date ON ai_usage_daily(date_utc);
