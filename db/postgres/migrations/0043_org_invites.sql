-- 0043_org_invites.sql
-- Email-based organization invitations.
--
-- Mirrors project_invites but org-scoped: an org owner mints a tokenized link
-- (optionally email-bound); redeeming it grants an org_members row. Invites are
-- single-org, so the token alone is the primary key (unlike project_invites,
-- whose multi-project support keys on (token, project_id)).
CREATE TABLE org_invites (
    token      TEXT PRIMARY KEY,
    org_id     BIGINT NOT NULL,
    role_level INTEGER NOT NULL,
    created_by BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ,
    used_by    BIGINT,
    used_at    TIMESTAMPTZ,
    email      TEXT
);
CREATE INDEX idx_org_invites_org ON org_invites(org_id);
CREATE INDEX idx_org_invites_unused ON org_invites(org_id, used_by) WHERE used_by IS NULL;
