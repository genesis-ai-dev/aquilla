-- AQU-626: authenticated per-user deep links (fresh-browser / diode-zone flow).
--
-- A translator in a surveillance-sensitive context reaches Aquilla via a link
-- placed inside a diode zone, opened in a Brave profile that wipes on close —
-- so every session is a fresh browser. This table backs a REUSABLE per-user
-- link + PIN that logs a specific pre-provisioned account straight into one
-- project, skipping onboarding.
--
-- Security model (decided on AQU-626, "simple, robust, effective, maintained"):
--   * The link alone grants nothing — redemption requires the per-user PIN,
--     which is scrypt-hashed here exactly like a password (never stored plain).
--   * Any redemption failure (unknown token, revoked, expired, locked, or wrong
--     PIN) returns one indistinguishable error, so a wrong PIN behaves like a
--     dead link — no oracle to enumerate tokens or probe PIN correctness.
--   * `failed_attempts` + `locked_until` throttle online PIN guessing; combined
--     with scrypt this makes short numeric PINs infeasible to brute-force.
--   * The link is reusable (no single-use stamp) so re-opening after a browser
--     wipe works identically; `revoked_at` soft-kills a leaked link.
CREATE TABLE IF NOT EXISTS project_access_links (
    token           TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    user_id         INTEGER NOT NULL,
    pin_hash        TEXT NOT NULL,
    role_level      INTEGER NOT NULL DEFAULT 400,
    created_by      INTEGER NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at      TIMESTAMP,
    revoked_at      TIMESTAMP,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMP,
    last_used_at    TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_access_links_project ON project_access_links(project_id);
CREATE INDEX IF NOT EXISTS idx_project_access_links_user ON project_access_links(user_id);
