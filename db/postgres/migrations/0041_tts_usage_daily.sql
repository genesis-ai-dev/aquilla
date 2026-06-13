-- OmniVoice TTS usage metering (2026-06-13-omnivoice-tts-design.md §3)
--
-- Stores per-user, org-attributed audio-seconds generated via the TTS route.
-- org_id = 0, user_id = 0 → global sentinel row (platform total, O(1) read).
-- Org totals are derived at read time: SUM(...) WHERE org_id = ? over user rows.
-- user_id = 0, org_id = 0 is reserved for the global sentinel.

CREATE TABLE IF NOT EXISTS tts_usage_daily (
  user_id       INTEGER          NOT NULL,
  org_id        INTEGER          NOT NULL,
  date_utc      DATE             NOT NULL,
  request_count INTEGER          NOT NULL DEFAULT 0,
  audio_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, org_id, date_utc)
);

CREATE INDEX IF NOT EXISTS idx_tts_usage_org_date ON tts_usage_daily (org_id, date_utc);
