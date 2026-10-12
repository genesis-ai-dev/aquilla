-- AQU-1491: operator grants affect the weekly ledger, never Stripe billing.
ALTER TABLE org_billing ADD COLUMN IF NOT EXISTS weekly_allowance BIGINT
  CHECK (weekly_allowance >= 0 AND weekly_allowance <= 10000000);
