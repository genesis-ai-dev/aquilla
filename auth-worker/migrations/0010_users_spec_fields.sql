-- Migration: 0010_users_spec_fields.sql
-- Description: Add the spec's User fields the current schema is missing
--   (03-data-model.md §"User"): display_name (human-presented name in
--   members lists) and avatar_url (optional). Both are nullable; existing
--   reads continue to use `username` until UIs migrate.
--
--   Spec text: "stable user id, email (unique), display name, optional
--   avatar, password hash, password-reset token state." Our schema already
--   has the id (INTEGER AUTOINCREMENT, the chosen stable surrogate), email
--   uniqueness, password_hash, and a separate password_reset_tokens table —
--   only display_name + avatar are missing.

ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN avatar_url   TEXT;
