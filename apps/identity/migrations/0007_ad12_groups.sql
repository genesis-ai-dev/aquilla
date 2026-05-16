-- Migration: 0007_ad12_groups.sql
-- Description: AD-12 (spec 02-foundations.md, 03-data-model.md §"Group" /
--   §"Group member" / §"Group project grant"). Adds org-scoped permission
--   bundles. A `Group` belongs to one Org; users are added via `group_members`
--   (must already be in `org_members` for the same org); projects attach via
--   `group_project_grants` carrying their own `role_level`. Resolution becomes
--   max-wins across direct + group + org + creator paths — implemented in
--   apps/identity/src/services/project-permissions.ts.
--
-- Cardinality invariants the schema enforces:
--   - groups.(org_id, name) is UNIQUE within an org (display-name uniqueness).
--   - group_members.(group_id, user_id) is UNIQUE.
--   - group_project_grants.(group_id, project_id) is UNIQUE.
--
-- Invariants the schema CANNOT enforce (SQLite has no cross-row CHECK):
--   - group_members.user_id must be present in org_members with the same
--     org_id as the group. Enforced in the (future) `add-user-to-group` route.
--   - group_project_grants.project_id's project.org_id must equal the group's
--     org_id (no cross-org attachments). Enforced in the (future)
--     `attach-group-to-project` route.
--
-- Cascade behavior (spec §"Group lifecycle"):
--   - Deleting a group cascades to its members and project grants.
--   - Deleting an org cascades to its groups (and transitively members /
--     project grants).
--   - Removing an org member is expected to cascade in the route to remove
--     that user from every group in that org; the schema does not enforce it
--     (org_members is keyed by (org_id, user_id) so a FK can't follow the
--     user across orgs).

CREATE TABLE groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id      INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    description TEXT,
    created_by  INTEGER NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (org_id)     REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    UNIQUE (org_id, name)
);
CREATE INDEX idx_groups_org ON groups(org_id);

CREATE TABLE group_members (
    group_id  INTEGER NOT NULL,
    user_id   INTEGER NOT NULL,
    added_by  INTEGER,
    added_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    FOREIGN KEY (added_by) REFERENCES users(id)
);
CREATE INDEX idx_group_members_user ON group_members(user_id);

CREATE TABLE group_project_grants (
    group_id    INTEGER NOT NULL,
    project_id  TEXT    NOT NULL,
    role_level  INTEGER NOT NULL,
    granted_by  INTEGER,
    granted_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, project_id),
    FOREIGN KEY (group_id)   REFERENCES groups(id)    ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id)  ON DELETE CASCADE,
    FOREIGN KEY (granted_by) REFERENCES users(id)
);
CREATE INDEX idx_gpg_project ON group_project_grants(project_id);
