-- AQU-2535: monotonic password-reset generation, independent of timestamp precision.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
