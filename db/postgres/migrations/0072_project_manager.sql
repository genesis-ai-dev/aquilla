-- AQU-507: designate a Project Manager per project.
--
-- The PM is an *attribution* ("who is responsible for this project"), stored
-- as a dedicated column rather than derived from the PROJECT_LEAD (500)
-- permission tier: a project can hold many leads, so derivation yields no
-- single deterministic value to sort/filter on, and naming a PM must not
-- require granting write access (nor vice-versa). Nullable = unassigned.
--
-- ON DELETE SET NULL: removing a user must never orphan the project row — the
-- project simply reverts to "unassigned".
ALTER TABLE projects ADD COLUMN pm_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX idx_projects_pm_user ON projects(pm_user_id) WHERE pm_user_id IS NOT NULL;
