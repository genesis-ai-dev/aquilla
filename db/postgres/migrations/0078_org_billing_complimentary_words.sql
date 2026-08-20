-- 0078: complimentary word grants on org_billing.
--
-- Additive column with DEFAULT 0. Existing rows stay valid. Old workers that
-- do not SELECT this column keep working. Safe to apply before the admin
-- billing UI ships — unused extra allowance is zero until an admin grants.
--
-- NOT applied automatically to live Neon branches. Apply by hand:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0078_org_billing_complimentary_words.sql

ALTER TABLE org_billing
  ADD COLUMN IF NOT EXISTS complimentary_words INTEGER NOT NULL DEFAULT 0;
