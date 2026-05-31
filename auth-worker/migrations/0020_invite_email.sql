-- 0020_invite_email.sql
-- Persist the optional recipient email on a share-link invite. Today the
-- email arg is accepted by POST /:projectId/invites but never stored, so the
-- JoinPage can't prefill the sign-up form and we can't deliver the link.
-- Nullable: "anyone with the link" invites carry no email.
ALTER TABLE project_invites ADD COLUMN email TEXT;
