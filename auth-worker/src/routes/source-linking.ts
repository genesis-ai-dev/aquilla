// Source-project link/detach + archive enforcement routes
// (Aquilla AD-9 / 03-data-model.md §"Source-project linking").
//
// Mounted at /api/v2/projects in src/index.ts as a sibling router to
// `routes/projects.ts` so the source-linking surface lives outside the
// existing routes file and can evolve independently of Phase 1A's work
// on the projects table. Sub-paths:
//
//   POST   /:projectId/link-source        link to upstream  (project_lead+)
//   POST   /:projectId/detach-source      clear upstream    (project_lead+)
//   DELETE /:projectId                    blocked-if-downstreams owner-only
//
// The archive / unarchive flow already exists in routes/projects.ts. This
// file adds the source-linking surface only — it does NOT redefine archive
// (avoiding the conflict 1A might also touch). It does add the
// archive-with-downstreams **warning surface**: GET /:projectId/downstreams
// returns the linked-target ids so the client can render a confirmation
// dialog before POSTing /:projectId/archive.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRoleIncludingArchived } from "../services/project-permissions"
import {
  chainContains,
  emitLinkSourceEvent,
  listDownstreamProjects,
  loadProjectWithSource,
  snapshotSourceCells,
  triggerLinkSeedSync,
} from "../services/source-linking"

const sourceLinking = new Hono<AuthHonoEnv>()

const LINK_MIN_ROLE = ROLE.PROJECT_LEAD // 500

// FRO-476: mode/consumes/gate are optional so existing callers (pre-FRO-476
// clients) keep working — defaulting to 'clone' preserves today's behavior
// (no mirror sync runs) rather than silently opting an old client into live
// mirroring. `consumes`/`gate` default per the design spec §2 ('source' /
// 'validated').
const linkSourceSchema = z.object({
  sourceProjectId: z.string().min(1).max(256),
  mode: z.enum(["clone", "live"]).optional(),
  consumes: z.enum(["source", "target"]).optional(),
  gate: z.enum(["head", "validated"]).optional(),
})

// ──────────────────────────────────────────────────────────────────────────
// POST /:projectId/link-source
// ──────────────────────────────────────────────────────────────────────────

sourceLinking.post(
  "/:projectId/link-source",
  authMiddleware,
  zValidator("json", linkSourceSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const {
      sourceProjectId,
      mode = "clone",
      consumes = "source",
      gate = "validated",
    } = c.req.valid("json")

    if (sourceProjectId === projectId) {
      return c.json({ error: "a project cannot link to itself" }, 400)
    }

    const role = await resolveProjectRoleIncludingArchived(c.env, user, projectId)
    if (!role) return c.json({ error: "not found or no access" }, 403)
    if (role.level < LINK_MIN_ROLE) {
      return c.json(
        { error: `role >= project_lead (${LINK_MIN_ROLE}) required` },
        403,
      )
    }

    const project = await loadProjectWithSource(c.env, projectId)
    if (!project) return c.json({ error: "project not found" }, 404)

    const source = await loadProjectWithSource(c.env, sourceProjectId)
    if (!source) {
      return c.json({ error: "source project not found" }, 404)
    }

    // Cycle check: starting at the prospective source, walk its source
    // chain upstream. If we ever encounter `projectId`, accepting the link
    // would create a cycle.
    const wouldCycle = await chainContains(c.env, sourceProjectId, projectId)
    if (wouldCycle) {
      return c.json(
        {
          error:
            "linking would create a cycle (source project is already downstream of this one)",
        },
        409,
      )
    }

    try {
      // FRO-476: persist link metadata alongside source_project_id. Cursor
      // resets to 0 on (re)link so a fresh live link always seeds from
      // scratch via the mirror sync (§5 — "seeding IS the first mirror
      // sync"), regardless of any prior link's cursor position.
      await c.env.AQUILLA_PG.prepare(
        `UPDATE projects
            SET source_project_id    = ?,
                source_link_mode     = ?,
                source_link_consumes = ?,
                source_link_gate     = ?,
                source_link_cursor   = 0,
                updated_at           = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
        .bind(sourceProjectId, mode, consumes, gate, projectId)
        .run()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("link-source UPDATE failed:", err)
      return c.json({ error: `link failed: ${message}` }, 500)
    }

    // Emit the durable event. 1A's projector consumes this kind.
    await emitLinkSourceEvent(c.env, {
      projectId,
      authorUsername: user.username,
      sourceProjectId,
    })

    // FRO-476: seeding IS the first mirror sync (design spec §5) — only for
    // live links. Clone links stay on the existing snapshot-at-detach path
    // (this route never snapshots; clone-mode linking without an immediate
    // detach is a link with no propagation, matching "one-time snapshot at
    // creation" only once FRO-478's create-from-template flow calls detach
    // right after linking, or a future slice adds an explicit "snapshot now"
    // action — out of scope here). Best-effort; the lazy-pull trigger on
    // next file-open self-heals if this fails.
    if (mode === "live") {
      await triggerLinkSeedSync(c.env, projectId)
    }

    return c.json({
      projectId,
      sourceProjectId,
      mode,
      consumes,
      gate,
      previousSourceProjectId: project.source_project_id,
    })
  },
)

// ──────────────────────────────────────────────────────────────────────────
// POST /:projectId/detach-source
//
// Per spec §Project lifecycle step 4: clears `source_project_id`, emits
// project.link-source with null, and bursts source.cell.commit events that
// snapshot the upstream's current source cells into this project's own
// source side.
// ──────────────────────────────────────────────────────────────────────────

sourceLinking.post("/:projectId/detach-source", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string

  const role = await resolveProjectRoleIncludingArchived(c.env, user, projectId)
  if (!role) return c.json({ error: "not found or no access" }, 403)
  if (role.level < LINK_MIN_ROLE) {
    return c.json(
      { error: `role >= project_lead (${LINK_MIN_ROLE}) required` },
      403,
    )
  }

  const project = await loadProjectWithSource(c.env, projectId)
  if (!project) return c.json({ error: "project not found" }, 404)

  if (project.source_project_id == null) {
    return c.json({ error: "project is not linked to an upstream source" }, 409)
  }

  const upstreamId = project.source_project_id

  try {
    // FRO-476: clear link metadata too — detach makes the project fully
    // self-contained (mode/consumes/gate no longer apply; cursor resets so
    // a future re-link starts clean).
    await c.env.AQUILLA_PG.prepare(
      `UPDATE projects
          SET source_project_id    = NULL,
              source_link_mode     = NULL,
              source_link_consumes = NULL,
              source_link_gate     = NULL,
              source_link_cursor   = 0,
              updated_at           = CURRENT_TIMESTAMP
        WHERE id = ?`,
    )
      .bind(projectId)
      .run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("detach-source UPDATE failed:", err)
    return c.json({ error: `detach failed: ${message}` }, 500)
  }

  // 1) Durable link-source event with null payload.
  await emitLinkSourceEvent(c.env, {
    projectId,
    authorUsername: user.username,
    sourceProjectId: null,
  })

  // 2) Burst source.cell.commit events copying upstream's current source
  //    cells. Per spec: "snapshot of upstream becomes their local source."
  const snapshotted = await snapshotSourceCells(c.env, {
    upstreamProjectId: upstreamId,
    targetProjectId: projectId,
    authorUsername: user.username,
  })

  return c.json({
    projectId,
    previousSourceProjectId: upstreamId,
    snapshottedCellCount: snapshotted,
  })
})

// ──────────────────────────────────────────────────────────────────────────
// GET /:projectId/downstreams — list ids of projects whose source_project_id
// points at :projectId. Used by the client to render the "X linked targets
// will continue reading from this archived/deleted upstream" warning.
// ──────────────────────────────────────────────────────────────────────────

sourceLinking.get("/:projectId/downstreams", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string

  const role = await resolveProjectRoleIncludingArchived(c.env, user, projectId)
  if (!role) return c.json({ error: "not found or no access" }, 403)

  const downstreams = await listDownstreamProjects(c.env, projectId)
  return c.json({ projectId, downstreams })
})

// ──────────────────────────────────────────────────────────────────────────
// DELETE /:projectId — hard delete, OWNER-only.
//
// Blocked when any other project's source_project_id points at this one
// (spec §Project lifecycle step 7: "Deleting an upstream source project
// that has linked targets is blocked until either the targets are
// detached … or are also deleted").
// ──────────────────────────────────────────────────────────────────────────

sourceLinking.delete("/:projectId", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string

  const role = await resolveProjectRoleIncludingArchived(c.env, user, projectId)
  if (!role) return c.json({ error: "not found or no access" }, 403)
  if (role.level < ROLE.OWNER) {
    return c.json({ error: "only owners can delete a project" }, 403)
  }

  const downstreams = await listDownstreamProjects(c.env, projectId)
  if (downstreams.length > 0) {
    return c.json(
      {
        error:
          "cannot delete: project has linked-target downstreams; detach or delete them first",
        downstreams,
      },
      409,
    )
  }

  try {
    await c.env.AQUILLA_PG.prepare("DELETE FROM projects WHERE id = ?")
      .bind(projectId)
      .run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("project DELETE failed:", err)
    return c.json({ error: `delete failed: ${message}` }, 500)
  }

  return c.json({ ok: true, projectId })
})

export default sourceLinking
