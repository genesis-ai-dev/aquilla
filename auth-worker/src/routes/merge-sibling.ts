// AQU-538 slice 4: opt-in sibling-project merge tool (identity surface).
//
// Mounted at /api/v2/projects in src/index.ts as a sibling router to
// routes/projects.ts / routes/source-linking.ts.
//
//   POST /:projectId/merge-sibling   { donorProjectId, lane }
//
// Folds a legacy single-pair "sibling" project (the donor) into the host as
// one additional target-language LANE. The host keeps its existing lanes; the
// donor's DEFAULT-lane translations become the host's new `lane`. Requires
// project_lead (500)+ on BOTH projects (you must own both to combine them).
//
// Flow (design decision 7 — FINAL):
//   1. Authorize 500+ on host AND donor; validate the lane + donor state.
//   2. Mint a service sync-token and POST the sync-worker fold endpoint
//      (services/merge-sibling.ts). The fold streams the donor's default-lane
//      translations onto the host lane as front-door target.cell.commit events
//      (deterministic ids → idempotent re-runs); cells with no matching host
//      source cell_id come back as `skipped`.
//   3. On a 2xx fold: register the lane on the host settings (targetLanes +
//      version bump), archive the donor (existing archive semantics), and write
//      a { mergedInto, mergedLane } pointer into the donor's settings blob.
//   4. Return the fold report + the actions taken.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { listDownstreamProjects, loadProjectWithSource } from "../services/source-linking"
import { triggerMergeSiblingFold } from "../services/merge-sibling"

const mergeSibling = new Hono<AuthHonoEnv>()

const MERGE_MIN_ROLE = ROLE.PROJECT_LEAD // 500
const MAX_LANE_LEN = 64

const mergeSiblingSchema = z.object({
  donorProjectId: z.string().min(1).max(256),
  lane: z.string().min(1).max(256),
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

function readTargetLanes(settings: Record<string, unknown>): string[] {
  const raw = settings.targetLanes
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []
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
    const { donorProjectId } = c.req.valid("json")
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
    const donorRole = await resolveProjectRole(c.env, user, donorProjectId)
    if (!donorRole) return c.json({ error: "not found or no access to donor project" }, 403)
    if (donorRole.level < MERGE_MIN_ROLE) {
      return c.json(
        { error: `role >= project_lead (${MERGE_MIN_ROLE}) required on donor project` },
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

    // Lane must not already be registered on the host.
    const hostSettings = await loadProjectSettings(c.env, hostId)
    const existingLanes = readTargetLanes(hostSettings.settings)
    if (existingLanes.includes(lane)) {
      return c.json({ error: `lane "${lane}" already exists on the host project` }, 400)
    }

    // Fold the donor's default-lane translations into the host lane via the
    // sync-worker front door. If this fails, DON'T mutate anything — the donor
    // stays live and re-runnable.
    const fold = await triggerMergeSiblingFold(c.env, {
      hostProjectId: hostId,
      donorProjectId,
      lane,
    })
    if (!fold.ok) {
      return c.json({ error: fold.error }, fold.status === 500 ? 500 : 502)
    }

    // Register the lane on the host + bump settings version.
    await writeProjectSettings(
      c.env,
      hostId,
      hostSettings,
      { ...hostSettings.settings, targetLanes: [...existingLanes, lane] },
      user.id,
    )

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
      { ...donorSettings.settings, mergedInto: hostId, mergedLane: lane },
      user.id,
    )

    return c.json({
      hostId,
      donorProjectId,
      lane,
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
