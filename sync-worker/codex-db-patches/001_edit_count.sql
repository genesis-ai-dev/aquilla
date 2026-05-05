-- Applied after frontier-server codex_migrations (see scripts/e2e-up.ts).
-- For remote D1, add an equivalent migration under frontier-server/cloudflare/codex_migrations.
ALTER TABLE cells ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0;
