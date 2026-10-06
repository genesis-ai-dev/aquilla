-- AQU-1491: retain historical sandbox identity while allowing explicit live attempts.
ALTER TABLE workspace_checkout_attempts
  DROP CONSTRAINT IF EXISTS workspace_checkout_attempts_sandbox_check;
