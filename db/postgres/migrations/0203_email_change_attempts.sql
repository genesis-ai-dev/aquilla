-- AQU-957: atomically cap guesses for six-digit mailbox verification.
ALTER TABLE email_change_requests ADD COLUMN confirmation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_attempts BETWEEN 0 AND 5);
