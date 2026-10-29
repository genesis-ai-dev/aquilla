// AQU-538 slice 4: opt-in sibling-project merge tool (identity surface).
//
// Mounted at /api/v2/projects in src/index.ts as a sibling router to
// routes/projects.ts / routes/source-linking.ts.
//
//   POST /:projectId/merge-sibling   { donorProjectId, lane, donorLaneId? }
//
// Folds a legacy single-pair "sibling" project (the donor) into the host as
// one additional target-language LANE. The host keeps its existing lanes; one
// donor lane's translations become the host's new `lane`. Requires
// project_lead (500)+ on BOTH projects (you must own both to combine them).
//
// AQU-1602: `donorLaneId` names the donor lane to fold, by `lanes.id`. Omit it
// and the fold takes the donor's single active lane — the legacy pair project
// this tool exists for. A donor with several active lanes comes back 400 with
// the candidates, so the operator chooses rather than the server guessing.
//
// Flow (design decision 7 — FINAL):
//   1. Authorize 500+ on host AND donor; validate the lane + donor state.
//   2. Mint a service sync-token and POST the sync-worker fold endpoint
//      (services/merge-sibling.ts). The fold streams the donor's default-lane
//      translations onto the host lane as front-door target.cell.commit events
//      (deterministic ids → idempotent re-runs); cells with no matching host
//      source cell_id come back as `skipped`.
//   3. On a 2xx fold: make sure the host lane row exists, archive the donor
//      (existing archive semantics), and write a { mergedInto, mergedLane }
//      pointer into the donor's settings blob.
//   4. Return the fold report + the actions taken.
//
// The lane is a real lane (AQU-1550): the fold creates its `lanes` record with
// the first rows it writes, named after the tag. A fold that matched nothing
// writes no rows, so step 3 creates the record itself. AQU-2223: the lane row
// is the only registry — the host's `settings.targetLanes` is neither read nor
// written. A maintainer renames the lane afterwards like any other lane.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { roleWithoutUnelevatedAdmin } from "../services/elevation-gate"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { listDownstreamProjects, loadProjectWithSource } from "../services/source-linking"
import { triggerMergeSiblingFold } from "../services/merge-sibling"
import { ensureTargetLaneStmt, listProjectLanes, retryingLaneIdCollision } from "../../../db/shared/lanes"
import { grantNewLaneStmt } from "../../../db/shared/lane-grants"
import { laneNameProblem } from "../../../src/lib/lanes/lane-name"
import { laneDisplayName } from "../../../src/lib/lanes/lane-display"

const mergeSibling = new Hono<AuthHonoEnv>()

const MERGE_MIN_ROLE = ROLE.PROJECT_LEAD // 500
const MAX_LANE_LEN = 64

const mergeSiblingSchema = z.object({
  donorProjectId: z.string().min(1).max(256),
  lane: z.string().min(1).max(256),
  /** AQU-1602: `lanes.id` on the DONOR. Omitted = its single active lane. */
  donorLaneId: z.string().min(1).max(256).optional(),
})

// ── project_settings helpers (mirror routes/project-settings.ts internals) ──

interface LoadedSettings {
  settings: Record<string, unknown>
  version: number
  hasRow: boolean
}

async function loadProjectSettings(
  env: AuthHonoEnv["Bindings"],
  projectId: string,
): Promise<LoadedSettings> {
  const row = await env.AQUILLA_PG.prepare(
    `SELECT settings, version FROM project_settings WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<{ settings: string; version: number }>()
  if (!row) return { settings: {}, version: 0, hasRow: false }
  let settings: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.settings)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>
    }
  } catch {
    settings = {}
  }
  return { settings, version: Number(row.version), hasRow: true }
}

const MERGE_AUTHOR = "merge-sibling" // sync-worker/src/events/merge-sibling-route.ts

/**
 * Does the host already have a target lane with this tag that holds someone's
 * work? A lane whose only rows came from an earlier run of this merge is not a
 * clash — running the merge again must finish the job — and neither is an
 * empty one.
 */
async function hostLaneInUse(
  env: AuthHonoEnv["Bindings"],
  hostId: string,
  tag: string,
): Promise<boolean> {
  const row = await env.AQUILLA_PG.prepare(
    `SELECT 1 AS present
       FROM cells c
       JOIN lanes l ON l.project_id = c.project_id AND l.id = c.lane_id
      WHERE c.project_id = ? AND l.role = 'target' AND l.legacy_tag = ?
        AND c.last_editor IS DISTINCT FROM ?
      LIMIT 1`,
  )
    .bind(hostId, tag, MERGE_AUTHOR)
    .first<{ present: number }>()
  return row != null
}

/** Upsert a project's settings blob with a version bump, following the
 *  project-settings route's insert-vs-update shape. */
async function writeProjectSettings(
  env: AuthHonoEnv["Bindings"],
  projectId: string,
  current: LoadedSettings,
  nextSettings: Record<string, unknown>,
  userId: number,
): Promise<void> {
  const json = JSON.stringify(nextSettings)
  if (current.hasRow) {
    await env.AQUILLA_PG.prepare(
      `UPDATE project_settings
          SET settings   = ?,
              version    = version + 1,
              updated_at = CURRENT_TIMESTAMP,
              updated_by = ?
        WHERE project_id = ?`,
    )
      .bind(json, userId, projectId)
      .run()
  } else {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by)
       VALUES (?, ?, 1, ?)`,
    )
      .bind(projectId, json, userId)
      .run()
  }
}

// ── route ───────────────────────────────────────────────────────────────────

mergeSibling.post(
  "/:projectId/merge-sibling",
  authMiddleware,
  zValidator("json", mergeSiblingSchema),
  async (c) => {
    const user = c.get("user")
    const hostId = c.req.param("projectId") as string
    const { donorProjectId, donorLaneId } = c.req.valid("json")
    const lane = c.req.valid("json").lane.trim()

    // Lane validation: non-empty (post-trim), bounded length.
    if (!lane) return c.json({ error: "lane must be non-empty" }, 400)
    if (lane.length > MAX_LANE_LEN) {
      return c.json({ error: `lane must be <= ${MAX_LANE_LEN} characters` }, 400)
    }
    if (donorProjectId === hostId) {
      return c.json({ error: "a project cannot merge into itself" }, 400)
    }

    // project_lead (500)+ on BOTH host and donor.
    const hostRole = await resolveProjectRole(c.env, user, hostId)
    if (!hostRole) return c.json({ error: "not found or no access to host project" }, 403)
    if (hostRole.level < MERGE_MIN_ROLE) {
      return c.json(
        { error: `role >= project_lead (${MERGE_MIN_ROLE}) required on host project` },
        403,
      )
    }
    // OPS-44: folding is irreversible and cross-tenant — a platform admin
    // resolves 700 on BOTH sides of a merge between two projects they have no
    // genuine grant on. AQU-1322 already requires elevation to add one member
    // to one project; destroying a donor project outranks that. Admin power is
    // stripped unless elevated, then the SAME role floor is re-applied to what
    // remains, so an operator who genuinely leads the project is unaffected.
    // Checked per side so the host is settled before the donor row is read.
    const hostEffective = await roleWithoutUnelevatedAdmin(c, user, hostId, hostRole)
    if (!hostEffective || hostEffective.level < MERGE_MIN_ROLE) {
      return c.json(
        { error: "elevation required to fold a sibling project with platform-admin access" },
        403,
      )
    }
    const donorRole = await resolveProjectRole(c.env, user, donorProjectId)
    if (!donorRole) return c.json({ error: "not found or no access to donor project" }, 403)
    if (donorRole.level < MERGE_MIN_ROLE) {
      return c.json(
        { error: `role >= project_lead (${MERGE_MIN_ROLE}) required on donor project` },
        403,
      )
    }
    const donorEffective = await roleWithoutUnelevatedAdmin(c, user, donorProjectId, donorRole)
    if (!donorEffective || donorEffective.level < MERGE_MIN_ROLE) {
      return c.json(
        { error: "elevation required to fold a sibling project with platform-admin access" },
        403,
      )
    }

    // Donor must exist, not be archived, and have no downstream links (folding
    // a project that others read from would orphan them).
    const donor = await loadProjectWithSource(c.env, donorProjectId)
    if (!donor) return c.json({ error: "donor project not found" }, 404)
    if (donor.archived_at != null) {
      return c.json({ error: "donor project is archived" }, 400)
    }
    const downstreams = await listDownstreamProjects(c.env, donorProjectId)
    if (downstreams.length > 0) {
      return c.json(
        {
          error: "donor project has linked-target downstreams; detach them first",
          downstreams,
        },
        400,
      )
    }

    // Exact tag only. A second lane of the same language is legal; a display
    // name another lane already shows is refused just below.
    if (await hostLaneInUse(c.env, hostId, lane)) {
      return c.json({ error: `lane "${lane}" already exists on the host project` }, 400)
    }

    // AQU-1550: the fold creates the lane as a real lane, named after its
    // tag. Hold that name to the rule every other new lane meets (AQU-1418):
    // one another of the host's lanes already shows is refused — here, before
    // anything is written. A record already carrying this tag is the same lane
    // (an earlier attempt that got as far as creating it), not a clash.
    const hostLanes = await listProjectLanes(c.env.AQUILLA_PG, hostId)
    const nameProblem = laneNameProblem({
      laneId: "",
      name: lane,
      // AQU-1592: compare against what each host lane DISPLAYS — a lane that
      // stores only a language still shows that language, so it collides.
      others: hostLanes
        .filter((row) => row.legacyTag !== lane)
        .map((row) => ({ id: row.id, name: laneDisplayName(row) })),
    })
    if (nameProblem === "duplicate") {
      return c.json({ error: `a lane named "${lane}" already exists on the host project` }, 400)
    }

    // Fold the donor's default-lane translations into the host lane via the
    // sync-worker front door. If this fails, DON'T mutate anything — the donor
    // stays live and re-runnable.
    const fold = await triggerMergeSiblingFold(c.env, {
      hostProjectId: hostId,
      donorProjectId,
      lane,
      donorLaneId,
      caller: { userId: user.id, donorRoleSource: donorRole.source },
    })
    if (!fold.ok) {
      // AQU-1602: a 400 is the donor-lane refusal — the caller picks a lane and
      // runs the merge again. Nothing was written, so the donor stays live.
      if (fold.status === 400) {
        return c.json({ error: fold.error, donorLanes: fold.donorLanes ?? [] }, 400)
      }
      return c.json({ error: fold.error }, fold.status === 500 ? 500 : 502)
    }

    // A fold that matched nothing wrote no rows, so it created no lane. Create
    // it here — with the grant the fold would have written (AQU-1781) — so the
    // merged lane exists either way. Both statements keep an existing record.
    let hostLaneId = fold.result.hostLaneId ?? null
    if (!hostLaneId) {
      await retryingLaneIdCollision(() =>
        c.env.AQUILLA_PG.batch([
          ensureTargetLaneStmt(c.env.AQUILLA_PG, hostId, lane),
          grantNewLaneStmt(c.env.AQUILLA_PG, hostId, { legacyTag: lane }, null),
        ]),
      )
      const created = await c.env.AQUILLA_PG.prepare(
        `SELECT id FROM lanes WHERE project_id = ? AND role = 'target' AND legacy_tag = ?`,
      )
        .bind(hostId, lane)
        .first<{ id: string }>()
      hostLaneId = created?.id ?? null
    }

    // Archive the donor (existing archive semantics: stamp archived_at/by).
    await c.env.AQUILLA_PG.prepare(
      `UPDATE projects
          SET archived_at = CURRENT_TIMESTAMP,
              archived_by = ?
        WHERE id = ? AND archived_at IS NULL`,
    )
      .bind(user.id, donorProjectId)
      .run()

    // Write the merge pointer into the donor's settings blob so the donor
    // knows where its content went (and the UI can render a "merged into …"
    // banner on the archived project).
    const donorSettings = await loadProjectSettings(c.env, donorProjectId)
    await writeProjectSettings(
      c.env,
      donorProjectId,
      donorSettings,
      {
        ...donorSettings.settings,
        mergedInto: hostId,
        mergedLane: lane,
        // AQU-1602: which of the donor's lanes was folded, for the banner on
        // the archived donor and for anyone auditing the merge later.
        mergedFromLaneId: fold.result.donorLaneId ?? null,
      },
      user.id,
    )

    return c.json({
      hostId,
      donorProjectId,
      lane,
      // AQU-1602: both ends of the fold, by `lanes.id`, so a caller can address
      // the new host lane (and record which donor lane it came from) without
      // going back through the legacy tag.
      donorLaneId: fold.result.donorLaneId ?? null,
      hostLaneId,
      merged: fold.result.merged,
      skipped: fold.result.skipped,
      actions: {
        laneRegistered: true,
        donorArchived: true,
        donorPointerWritten: true,
      },
    })
  },
)

export default mergeSibling
