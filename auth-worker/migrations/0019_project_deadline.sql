-- 0019_project_deadline.sql
-- Optional per-project target date for manager oversight (overdue / at-risk
-- flags on the org Overview). Nullable; set or cleared by maintainer+ via
-- PATCH /api/v2/projects/:projectId/deadline. Stored as an ISO date string.
ALTER TABLE projects ADD COLUMN deadline_at DATETIME;
