-- AQU-1813: a team attachment can name the target lanes it covers.
--
-- lanes_explicit stays false for attachments that already exist and for a
-- project that has no target lane yet, so today's access is unchanged and a
-- lane created later still reaches a team that was attached before any lane
-- existed (the Codex content sweep). Where the project already has a target
-- lane, the attachment is frozen to those lanes: they are checked, and a lane
-- created afterwards stays off until someone edits the team.

ALTER TABLE group_project_grants
  ADD COLUMN IF NOT EXISTS lanes_explicit BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS group_project_lanes (
    group_id   BIGINT NOT NULL,
    project_id TEXT NOT NULL,
    lane_id    TEXT NOT NULL,
    PRIMARY KEY (group_id, project_id, lane_id)
);

INSERT INTO group_project_lanes (group_id, project_id, lane_id)
SELECT gpg.group_id, gpg.project_id, l.id
  FROM group_project_grants gpg
  JOIN lanes l
    ON l.project_id = gpg.project_id
   AND l.role = 'target'
   AND l.archived_at IS NULL
ON CONFLICT DO NOTHING;

UPDATE group_project_grants gpg
   SET lanes_explicit = true
 WHERE EXISTS (
   SELECT 1 FROM lanes l
    WHERE l.project_id = gpg.project_id
      AND l.role = 'target'
      AND l.archived_at IS NULL
 );

-- Team-only members of a frozen attachment: record the lanes they already
-- hold so a later lane is not handed to them by the "reads every lane" rule.
INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
SELECT g.project_id,
       g.user_id,
       'lane',
       g.lane,
       COALESCE(g.granted_by::text, '0'),
       (EXTRACT(EPOCH FROM now()) * 1000)::bigint
  FROM project_member_lane_roles g
  JOIN group_members gm ON gm.user_id = g.user_id
  JOIN group_project_grants gpg
    ON gpg.group_id = gm.group_id
   AND gpg.project_id = g.project_id
   AND gpg.lanes_explicit
 WHERE NOT EXISTS (
   SELECT 1 FROM project_members pm
    WHERE pm.project_id = g.project_id AND pm.user_id = g.user_id
 )
   AND NOT EXISTS (
   SELECT 1 FROM project_member_scopes s
    WHERE s.project_id = g.project_id
      AND s.user_id = g.user_id
      AND s.kind = 'lane'
 )
ON CONFLICT DO NOTHING;

-- Direct project leads who can see every lane today only because the read
-- wall opened at 500. Write an explicit grant and scope on each current
-- target lane so moving the wall to 600 does not hide those lanes, and so a
-- lane created later is not included until someone grants it.
WITH leads AS (
  SELECT pm.project_id, pm.user_id, pm.granted_by
    FROM project_members pm
   WHERE pm.role_level >= 500
     AND pm.role_level < 600
     AND NOT EXISTS (
       SELECT 1 FROM project_member_lane_roles g
        WHERE g.project_id = pm.project_id AND g.user_id = pm.user_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM project_member_scopes s
        WHERE s.project_id = pm.project_id
          AND s.user_id = pm.user_id
          AND s.kind = 'lane'
     )
),
inserted AS (
  INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
  SELECT leads.project_id, leads.user_id, l.id, 400, leads.granted_by
    FROM leads
    JOIN lanes l
      ON l.project_id = leads.project_id
     AND l.role = 'target'
     AND l.archived_at IS NULL
  ON CONFLICT DO NOTHING
  RETURNING project_id, user_id, lane, granted_by
)
INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
SELECT project_id,
       user_id,
       'lane',
       lane,
       COALESCE(granted_by::text, '0'),
       (EXTRACT(EPOCH FROM now()) * 1000)::bigint
  FROM inserted
ON CONFLICT DO NOTHING;
