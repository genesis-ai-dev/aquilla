// Source-project link/detach + archive enforcement routes
// (Aquilla AD-9 / 03-data-model.md §"Source-project linking").
//
// Mounted at /api/v2/projects in src/index.ts as a sibling router to
// `routes/projects.ts` so the source-linking surface lives outside the
// existing routes file and can evolve independently of Phase 1A's work
// on the projects table. Sub-paths:
//
//   POST   /:projectId/link-source        link to upstream  (project_lead+)
//   POST   /:projectId/link-source/match  how this project's files compare
//                                         with the upstream files they would
//                                         follow            (project_lead+)
//   GET    /:projectId/link-source/files  what the link follows, and which
//                                         files are stopped (project_lead+)
//   POST   /:projectId/link-source/files  add upstream files to a live
//                                         fixed-list link   (project_lead+)
//   POST   /:projectId/link-source/files/stop
//                                         stop following some of them, keeping
//                                         them as this project's own copies
//                                                           (project_lead+)
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
  clearLinkAdoption,
  clearLinkBackfill,
  emitLinkSourceEvent,
  listDownstreamProjects,
  loadLinkAdoption,
  loadLinkAdoptionRaw,
  loadLinkBackfillRaw,
  loadProjectWithSource,
  loadLinkFileIds,
  loadLinkFileIdsRaw,
  loadStoppedUpstreamFileIds,
  loadUpstreamFileIds,
  matchFilesForReplace,
  parseLinkFileIds,
  liveLinkKeepsLane,
  resolveUpstreamLinkLane,
  snapshotSourceCells,
  triggerLinkSeedSync,
} from "../services/source-linking"
import {
  mergeSourceLinkBackfill,
  parseSourceLinkBackfill,
  serializeSourceLinkBackfill,
} from "../../../db/shared/source-link-backfill"
import {
  parseSourceLinkAdoption,
  serializeSourceLinkAdoption,
} from "../../../db/shared/source-link-adopt"

const sourceLinking = new Hono<AuthHonoEnv>()

const LINK_MIN_ROLE = ROLE.PROJECT_LEAD // 500

// AQU-476: mode/consumes/gate are optional so existing callers (pre-AQU-476
// clients) keep working — defaulting to 'clone' preserves today's behavior
// (no mirror sync runs) rather than silently opting an old client into live
// mirroring. `consumes`/`gate` default per the design spec §2 ('source' /
// 'validated').
//
// AQU-1559: `fileIds` is the caller's file selection — the UPSTREAM file ids
// this link should follow. Omitted (the only shape any client sent before this
// slice) means the whole project: every file the upstream has now and every one
// it gains later, which is what every existing link does. A list means a fixed
// link: only those files mirror, and later upstream files are not among them.
// The ids are stored as given — the mirror matches on identity, so an id the
// upstream does not (or no longer) has simply never matches, and a client that
// passes the upstream's entire current list is asking for exactly that: those
// files, pinned.
//
// AQU-1679: `replaceFiles` names files this project ALREADY has that should
// follow an upstream file, instead of that upstream file arriving as a second
// copy. Each pair is an upstream file id and one of this project's own file
// ids. The project's file keeps its id and its cell ids — so every translation,
// validation and comment on it stays where it is — and the mirror writes the
// upstream's source onto it (sync-worker events/link-adopt.ts). Only a live
// link to the upstream's SOURCE can do this: a clone never syncs, and a chain
// link's source is the upstream's translations, which a file imported on its
// own cannot line up with.
const replaceFilePairSchema = z.object({
  upstreamFileId: z.string().min(1).max(256),
  fileId: z.string().min(1).max(256),
})

/** Why a set of replace pairs cannot be honoured as given, or null. */
/** Postgres `undefined_column` (42703), including when a transaction wrapper
 *  puts the code on `cause`. */
function isPgUndefinedColumn(error: unknown): boolean {
  const candidates: unknown[] = [error]
  if (error && typeof error === "object" && "cause" in error) {
    candidates.push((error as { cause?: unknown }).cause)
  }
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false
    return (candidate as { code?: unknown }).code === "42703"
  })
}

function replacePairsProblem(
  pairs: ReadonlyArray<{ upstreamFileId: string; fileId: string }>,
): string | null {
  if (new Set(pairs.map((p) => p.upstreamFileId)).size !== pairs.length) {
    return "an upstream file can replace the source of only one file"
  }
  if (new Set(pairs.map((p) => p.fileId)).size !== pairs.length) {
    return "a file can follow only one upstream file"
  }
  return null
}

const linkSourceSchema = z.object({
  sourceProjectId: z.string().min(1).max(256),
  mode: z.enum(["clone", "live"]).optional(),
  consumes: z.enum(["source", "target"]).optional(),
  gate: z.enum(["head", "validated"]).optional(),
  // Non-empty: "follow no files" is not a link, it is a mistake — the client
  // disables its own confirm button on an empty selection, and a request that
  // got past that is a 400 rather than a link that can never sync. The cap is a
  // whole Bible and then some; files.id is a UUID, hence 256.
  fileIds: z.array(z.string().min(1).max(256)).min(1).max(5000).optional(),
  // AQU-1605: WHICH of the upstream's lanes this link consumes, by `lanes.id`.
  // Omitted: the server picks when the choice is unambiguous (the upstream
  // source lane, or the one non-archived target lane this caller can see) and
  // 400s otherwise. A new link always stores a concrete id. Existing rows may
  // still be null until AQU-1616's backfill; that null means the '' lane.
  laneId: z.string().min(1).max(256).optional(),
  // Each pair costs a read of both files' source lines before the link is
  // saved, so the cap is a Bible's worth of books rather than the selection's.
  replaceFiles: z.array(replaceFilePairSchema).min(1).max(200).optional(),
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
      fileIds,
      laneId,
      replaceFiles,
    } = c.req.valid("json")

    // AQU-1559: deduped so the stored list is the set it is read as, and
    // serialized once here rather than at the two places it is bound below.
    // NULL (not '[]') is the whole-project link — every reader treats a null
    // column as "follow everything", which is what keeps pre-slice rows working.
    const followedFileIds = fileIds ? [...new Set(fileIds)] : null
    const followedFileIdsJson = followedFileIds ? JSON.stringify(followedFileIds) : null

    if (sourceProjectId === projectId) {
      return c.json({ error: "a project cannot link to itself" }, 400)
    }

    // AQU-1679: refused on shape alone, before any lookup.
    if (replaceFiles) {
      if (mode !== "live" || consumes !== "source") {
        return c.json(
          { error: "only a live link to the upstream's source can replace a file's source" },
          400,
        )
      }
      const problem = replacePairsProblem(replaceFiles)
      if (problem) return c.json({ error: problem }, 400)
      // A file the link does not follow cannot be followed INTO anything.
      if (followedFileIds && replaceFiles.some((p) => !followedFileIds.includes(p.upstreamFileId))) {
        return c.json({ error: "a replaced file must be one of the files the link follows" }, 400)
      }
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

    // [Pen test] AQU authz review: linking only ever checked the caller's
    // role on the downstream project. Without this check, any user who
    // owns (or leads) some project of their own — trivially true for
    // every authenticated user, since creating a project grants owner
    // (700) — could link it to ANY other project id on the platform and
    // clone/mirror its source cells, with no membership, invite, or
    // interaction from the target project. The caller must have at least
    // viewer access to the source project too.
    const sourceRole = await resolveProjectRoleIncludingArchived(c.env, user, sourceProjectId)
    if (!sourceRole) {
      return c.json({ error: "not found or no access to source project" }, 403)
    }

    // AQU-1605: the chosen upstream lane, checked against this caller's access
    // to the upstream — see resolveUpstreamLinkLane. Done after the source-role
    // check above so an outsider learns nothing about the upstream's lanes.
    const lane = await resolveUpstreamLinkLane(c.env, {
      upstreamProjectId: sourceProjectId,
      consumes,
      laneId,
      userId: user.id,
      upstreamRole: sourceRole.level,
    })
    if (!lane.ok) return c.json({ error: lane.error }, lane.status)

    // Re-pointing a live link at a different lane leaves the downstream source
    // as a mix of the old lane's text and the new one's. The stored cells are
    // not rewritten here. Detach first (that snapshots and clears the lane),
    // or send the lane the link already follows.
    if (project.source_project_id && project.source_link_mode === "live") {
      const stored = await c.env.AQUILLA_PG.prepare(
        `SELECT source_link_lane_id FROM projects WHERE id = ?`,
      )
        .bind(projectId)
        .first<{ source_link_lane_id: string | null }>()
      const keeps = await liveLinkKeepsLane(c.env, {
        upstreamProjectId: sourceProjectId,
        consumes,
        storedLaneId: stored?.source_link_lane_id ?? null,
        requestedLaneId: lane.laneId,
      })
      if (!keeps) {
        return c.json(
          { error: "detach the link before changing which upstream lane it follows" },
          409,
        )
      }
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

    // AQU-1679: the replace pairs are checked against the two projects' actual
    // lines BEFORE anything is saved — the same pairing the mirror is about to
    // perform. A pair that names a missing file, or two files that are not the
    // same material, refuses the whole request: the lead asked for one file and
    // must not silently get two.
    let adoptionJson: string | null = null
    if (replaceFiles) {
      const matches = await matchFilesForReplace(c.env, {
        projectId,
        sourceProjectId,
        pairs: replaceFiles,
      })
      if (matches.some((m) => !m.canReplace)) {
        return c.json(
          {
            error: "some files do not match the upstream files they were to follow",
            replaceFiles: matches,
          },
          422,
        )
      }
      adoptionJson = serializeSourceLinkAdoption({
        files: Object.fromEntries(replaceFiles.map((p) => [p.upstreamFileId, p.fileId])),
        pending: replaceFiles.map((p) => p.upstreamFileId),
      })
    }

    try {
      // AQU-476: persist link metadata alongside source_project_id. Cursor
      // resets to 0 on (re)link so a fresh live link always seeds from
      // scratch via the mirror sync (§5 — "seeding IS the first mirror
      // sync"), regardless of any prior link's cursor position.
      //
      // AQU-1679: the adopted files ride in the SAME statement as the link —
      // a link saved without them would mirror those files in as copies before
      // a second write could say otherwise. The column (migration 0140) is only
      // named when there is something to put in it, so a link that replaces
      // nothing still saves on a database that predates it.
      await c.env.AQUILLA_PG.prepare(
        `UPDATE projects
            SET source_project_id    = ?,
                source_link_mode     = ?,
                source_link_consumes = ?,
                source_link_gate     = ?,
                source_link_file_ids = ?,
                source_link_lane_id  = ?,
                ${adoptionJson !== null ? "source_link_adopt    = ?," : ""}
                source_link_cursor   = 0,
                updated_at           = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
        // AQU-1559: written on every link, including a whole-project one —
        // re-linking a project that previously followed a subset must clear the
        // old list, not inherit it.
        .bind(
          sourceProjectId,
          mode,
          consumes,
          gate,
          followedFileIdsJson,
          lane.laneId,
          ...(adoptionJson !== null ? [adoptionJson] : []),
          projectId,
        )
        .run()
    } catch (err) {
      // AQU-1559: `source_link_file_ids` arrives with migration 0127, and this
      // worker can be deployed before it is applied. A whole-project link does
      // not need that column, so an undefined-column (42703) retries without
      // it. The lane is still written — dropping it would save a default-lane
      // link (AQU-1605). A subset link cannot be honoured without the column,
      // and a missing lane column cannot either; both fail closed.
      // AQU-1679: `source_link_adopt` is named only when a replace was asked
      // for, so a database that predates it still saves a link that replaces
      // nothing. A replace that cannot be recorded fails closed — dropping the
      // column would mirror those files in as copies. The retry below drops
      // only `source_link_file_ids`, never the lane or the adoption.
      const cause = err && typeof err === "object" ? (err as { cause?: { code?: unknown } }).cause : undefined
      const missingColumn =
        (err as { code?: unknown } | null)?.code === "42703" || cause?.code === "42703"
      if (followedFileIdsJson !== null || adoptionJson !== null || !missingColumn) {
        console.error("link-source UPDATE failed:", err)
        return c.json({ error: "link failed" }, 500)
      }
      try {
        await c.env.AQUILLA_PG.prepare(
          `UPDATE projects
              SET source_project_id    = ?,
                  source_link_mode     = ?,
                  source_link_consumes = ?,
                  source_link_gate     = ?,
                  source_link_lane_id  = ?,
                  source_link_cursor   = 0,
                  updated_at           = CURRENT_TIMESTAMP
            WHERE id = ?`,
        )
          .bind(sourceProjectId, mode, consumes, gate, lane.laneId, projectId)
          .run()
      } catch (retryErr) {
        console.error("link-source UPDATE failed:", retryErr)
        return c.json({ error: "link failed" }, 500)
      }
    }

    // AQU-1560: a re-link is a fresh answer to "which files", like the
    // selection above — files that were part-way into the OLD link must not
    // carry over into this one.
    await clearLinkBackfill(c.env, projectId)
    // AQU-1679: and so is "which of my files does it follow into" — a link
    // that replaces nothing must not inherit the previous link's pairs.
    if (adoptionJson === null) await clearLinkAdoption(c.env, projectId)

    // Emit the durable event. 1A's projector consumes this kind.
    await emitLinkSourceEvent(c.env, {
      projectId,
      authorUsername: user.username,
      sourceProjectId,
    })

    // AQU-476/QA-BUG-1: seeding must happen at link time — a linked project
    // born with 0 files/cells has no way to self-heal (live's lazy-pull is
    // keyed to an open FILE; clone never syncs again after this call).
    //
    // - mode='live': trigger the first mirror sync now (§5 — "seeding IS the
    //   first mirror sync"). Awaited so the response only returns once
    //   seeding has actually run (or definitively failed) — the client no
    //   longer has to guess whether content will "just appear".
    // - mode='clone': run the one-time snapshot synchronously — this IS
    //   clone semantics (§2: "snapshot at birth"), not a side effect of
    //   detach. There is no later resync for clones, so this is the only
    //   chance to seed.
    let seeded = false
    if (mode === "live") {
      seeded = await triggerLinkSeedSync(c.env, projectId)
    } else {
      const snapshotted = await snapshotSourceCells(c.env, {
        upstreamProjectId: sourceProjectId,
        targetProjectId: projectId,
        authorUsername: user.username,
        // AQU-1559: a clone's one snapshot IS its whole content — there is no
        // later sync to narrow — so the selection has to apply here too.
        onlyUpstreamFileIds: followedFileIds,
      })
      seeded = snapshotted > 0
    }

    return c.json({
      projectId,
      sourceProjectId,
      mode,
      consumes,
      gate,
      // AQU-1559: the stored selection, echoed back. null = the whole project.
      fileIds: followedFileIds,
      // AQU-1605: the stored lane. Always a concrete upstream lane id.
      laneId: lane.laneId,
      // AQU-1679: the pairs recorded, echoed back. null = nothing replaced.
      replaceFiles: replaceFiles ?? null,
      previousSourceProjectId: project.source_project_id,
      // AQU-476/QA-BUG-1: best-effort signal — false means the client
      // should not assume content is present yet (e.g. the sync-worker
      // call failed) and may fall back to its own self-heal trigger.
      seeded,
    })
  },
)

// ──────────────────────────────────────────────────────────────────────────
// POST /:projectId/link-source/match  (AQU-1679)
//
// Before a link is made: how each of this project's files compares with the
// upstream file it would follow. Body: `{ sourceProjectId, files: [{
// upstreamFileId, fileId }, …] }`. Answers, per pair, how many lines are the
// same, how many would have their source text replaced, how many the upstream
// would add and how many only this project has — and whether the two are the
// same material at all (`canReplace`). The confirm step shows those numbers
// next to "Replace the source in my existing file", and the link request
// repeats the check itself before it records anything.
//
// POST because it carries a list; it writes nothing. Same access as the link it
// previews: project_lead+ here, and some access to the upstream, whose lines it
// reads.
// ──────────────────────────────────────────────────────────────────────────

const matchLinkFilesSchema = z.object({
  sourceProjectId: z.string().min(1).max(256),
  files: z.array(replaceFilePairSchema).min(1).max(200),
})

sourceLinking.post(
  "/:projectId/link-source/match",
  authMiddleware,
  zValidator("json", matchLinkFilesSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const { sourceProjectId, files } = c.req.valid("json")

    if (sourceProjectId === projectId) {
      return c.json({ error: "a project cannot link to itself" }, 400)
    }
    const role = await resolveProjectRoleIncludingArchived(c.env, user, projectId)
    if (!role) return c.json({ error: "not found or no access" }, 403)
    if (role.level < LINK_MIN_ROLE) {
      return c.json({ error: `role >= project_lead (${LINK_MIN_ROLE}) required` }, 403)
    }
    const sourceRole = await resolveProjectRoleIncludingArchived(c.env, user, sourceProjectId)
    if (!sourceRole) {
      return c.json({ error: "not found or no access to source project" }, 403)
    }

    try {
      const matches = await matchFilesForReplace(c.env, { projectId, sourceProjectId, pairs: files })
      return c.json({ projectId, sourceProjectId, files: matches })
    } catch (err) {
      console.error("link-source/match failed:", err)
      return c.json({ error: "could not compare those files" }, 500)
    }
  },
)

// ──────────────────────────────────────────────────────────────────────────
// POST /:projectId/link-source/files  (AQU-1560)
//
// Add more of the upstream's files to an existing live link that follows a
// fixed list (AQU-1559), without detaching and re-linking. Body:
// `{ fileIds: [<upstream file id>, …] }`.
//
// A file added late has to arrive WHOLE — the link's cursor is already past
// most of its history — so this does not touch the link's selection itself. It
// records the files as a pending addition (`projects.source_link_backfill`) and
// runs the mirror sync, which replays those files' upstream history and only
// then moves them into the selection (sync-worker events/link-sync.ts,
// runBackfill). If every upstream file is linked afterwards, the link becomes
// a whole-project one (AQU-1559's rule).
//
// `complete: false` means the addition is recorded but the files have not all
// arrived yet (the sync failed, or ran out of rounds). Nothing is half-added in
// the meantime: the files are not part of the link and not in the link's file
// list until they are complete. Calling again with the same files resumes the
// replay where it stopped, and so does any later sync of the link.
//
// AQU-1679: `replaceFiles` names files this project ALREADY has that an added
// upstream file should follow into, instead of arriving as a second copy —
// the link request's option, available here too. Same shape and checks as
// there; every pair's upstream file must be among the files being added. The
// pairs are recorded on `projects.source_link_adopt` before the addition, so
// the mirror sync joins the file to its upstream before it replays the file's
// history (sync-worker events/link-adopt.ts runs first).
// ──────────────────────────────────────────────────────────────────────────

const addLinkFilesSchema = z.object({
  // Same bounds as the link request's own `fileIds`.
  fileIds: z.array(z.string().min(1).max(256)).min(1).max(5000),
  replaceFiles: z.array(replaceFilePairSchema).min(1).max(200).optional(),
})

sourceLinking.post(
  "/:projectId/link-source/files",
  authMiddleware,
  zValidator("json", addLinkFilesSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const { fileIds, replaceFiles } = c.req.valid("json")

    // AQU-1679: refused on shape alone, before any lookup.
    if (replaceFiles) {
      const problem = replacePairsProblem(replaceFiles)
      if (problem) return c.json({ error: problem }, 400)
      if (replaceFiles.some((p) => !fileIds.includes(p.upstreamFileId))) {
        return c.json({ error: "a replaced file must be one of the files being added" }, 400)
      }
    }

    const role = await resolveProjectRoleIncludingArchived(c.env, user, projectId)
    if (!role) return c.json({ error: "not found or no access" }, 403)
    if (role.level < LINK_MIN_ROLE) {
      return c.json({ error: `role >= project_lead (${LINK_MIN_ROLE}) required` }, 403)
    }

    const project = await loadProjectWithSource(c.env, projectId)
    if (!project) return c.json({ error: "project not found" }, 404)
    const upstreamId = project.source_project_id
    if (!upstreamId) return c.json({ error: "project is not linked to a source" }, 409)
    // A one-time clone never syncs, so there is no replay to bring a file in
    // with — and a legacy link with no recorded mode is not mirrored either.
    if (project.source_link_mode !== "live") {
      return c.json({ error: "only a live link can have files added" }, 409)
    }
    // AQU-1679: a chain link's source is the upstream's translations, which a
    // file imported on its own cannot line up with — same rule as the link.
    if (replaceFiles && project.source_link_consumes === "target") {
      return c.json(
        { error: "only a link to the upstream's source can replace a file's source" },
        400,
      )
    }

    // The same check the link itself makes ([Pen test] AQU authz review):
    // adding files copies more of the upstream into this project, so the caller
    // must still be able to see the upstream now, not just when it was linked.
    const sourceRole = await resolveProjectRoleIncludingArchived(c.env, user, upstreamId)
    if (!sourceRole) {
      return c.json({ error: "not found or no access to source project" }, 403)
    }

    // A whole-project link already follows every upstream file, and files the
    // upstream gains arrive on their own: there is nothing to add.
    const followed = await loadLinkFileIds(c.env, projectId)
    if (!followed) {
      return c.json({ projectId, added: [], fileIds: null, complete: true })
    }

    // Only the upstream's current files, and only ones not already followed.
    // An id that is neither is ignored rather than refused — the list the
    // client sent was read a moment ago, and the upstream can change.
    const upstreamFileIds = new Set(await loadUpstreamFileIds(c.env, upstreamId))
    const followedSet = new Set(followed)
    const added = [...new Set(fileIds)].filter((id) => upstreamFileIds.has(id) && !followedSet.has(id))
    if (added.length === 0) {
      return c.json({ projectId, added: [], fileIds: followed, complete: true })
    }

    // AQU-1679: a pair for a file that is not actually being added — already
    // followed, or gone upstream — is refused rather than dropped: the lead
    // asked for one file, and silence here would quietly leave them with two.
    if (replaceFiles && replaceFiles.some((p) => !added.includes(p.upstreamFileId))) {
      return c.json({ error: "a replaced file must be one of the files being added" }, 400)
    }
    // The pairs are checked against the two projects' actual lines before
    // anything is recorded — the same pairing the mirror then performs.
    if (replaceFiles) {
      const matches = await matchFilesForReplace(c.env, {
        projectId,
        sourceProjectId: upstreamId,
        pairs: replaceFiles,
      })
      if (matches.some((m) => !m.canReplace)) {
        return c.json(
          {
            error: "some files do not match the upstream files they were to follow",
            replaceFiles: matches,
          },
          422,
        )
      }
      // Recorded BEFORE the addition, folded into whatever is already adopted
      // (a compare-and-set, as below): the sync that the addition triggers
      // must find the pairs, or it would replay the file in as a copy.
      let adopted = false
      for (let attempt = 0; attempt < 3 && !adopted; attempt++) {
        const current = await loadLinkAdoptionRaw(c.env, projectId)
        if (!current.ok) {
          // A database that predates migration 0140 cannot hold the pairs, and
          // adding the file as a copy is not what was asked.
          console.error(`link-source/files: source_link_adopt unreadable for ${projectId}`)
          return c.json({ error: "replacing a file's source is not available yet" }, 503)
        }
        const existing = parseSourceLinkAdoption(current.raw)
        const files = { ...(existing?.files ?? {}) }
        for (const pair of replaceFiles) files[pair.upstreamFileId] = pair.fileId
        const pending = [
          ...new Set([...(existing?.pending ?? []), ...replaceFiles.map((p) => p.upstreamFileId)]),
        ]
        try {
          const res = await c.env.AQUILLA_PG.prepare(
            `UPDATE projects SET source_link_adopt = ?
              WHERE id = ? AND source_link_adopt IS NOT DISTINCT FROM ?`,
          )
            .bind(serializeSourceLinkAdoption({ files, pending }), projectId, current.raw)
            .run()
          adopted = Number(res.meta?.changes ?? 0) > 0
        } catch (err) {
          console.error("link-source/files adopt UPDATE failed:", err)
          return c.json({ error: "could not add files" }, 500)
        }
      }
      if (!adopted) return c.json({ error: "the link changed while adding files; try again" }, 409)
    }

    // Record the addition, folded into anything already pending. A
    // compare-and-set against the column as read, because the mirror sync
    // writes it too (its replay progress) and may be running right now; a lost
    // race re-reads and folds again.
    let recorded = false
    for (let attempt = 0; attempt < 3 && !recorded; attempt++) {
      const current = await loadLinkBackfillRaw(c.env, projectId)
      if (!current.ok) {
        // A database that predates migration 0128 cannot hold the addition.
        console.error(`link-source/files: source_link_backfill unreadable for ${projectId}`)
        return c.json({ error: "adding files is not available yet" }, 503)
      }
      const next = serializeSourceLinkBackfill(
        mergeSourceLinkBackfill(parseSourceLinkBackfill(current.raw), added),
      )
      try {
        const res = await c.env.AQUILLA_PG.prepare(
          `UPDATE projects SET source_link_backfill = ?
            WHERE id = ? AND source_link_backfill IS NOT DISTINCT FROM ?`,
        )
          .bind(next, projectId, current.raw)
          .run()
        recorded = Number(res.meta?.changes ?? 0) > 0
      } catch (err) {
        console.error("link-source/files UPDATE failed:", err)
        return c.json({ error: "could not add files" }, 500)
      }
    }
    if (!recorded) return c.json({ error: "the link changed while adding files; try again" }, 409)

    // Bring them in. The sync route keeps going until the link is caught up,
    // which here means the replay has finished and the files have joined.
    await triggerLinkSeedSync(c.env, projectId)

    // Read the outcome back rather than trusting the sync's answer: a sync
    // that another trigger ran (or finished) in between is just as good.
    const after = await loadLinkFileIds(c.env, projectId)
    const pending = await loadLinkBackfillRaw(c.env, projectId)
    const stillPending = pending.ok ? parseSourceLinkBackfill(pending.raw) : null
    // AQU-1679: a file whose join has not run is not complete either — until it
    // has, the file is not yet the project's own file following the link.
    const stillJoining = replaceFiles ? (await loadLinkAdoption(c.env, projectId))?.pending ?? [] : []
    const afterSet = after ? new Set(after) : null
    const complete =
      !stillPending?.fileIds.some((id) => added.includes(id)) &&
      !stillJoining.some((id) => added.includes(id)) &&
      added.every((id) => afterSet === null || afterSet.has(id))

    // AQU-1679: echoed only when pairs were sent — an add that replaces nothing
    // answers exactly what it did before this slice.
    return c.json({ projectId, added, fileIds: after, ...(replaceFiles ? { replaceFiles } : {}), complete })
  },
)

// ──────────────────────────────────────────────────────────────────────────
// GET /:projectId/link-source/files  (AQU-1562)
//
// What "Choose files" needs that the project record cannot say: which of the
// upstream's files this link follows, AND which of the ones it does NOT follow
// are nonetheless here as a stopped copy. Both read as an unchecked row, and
// the two confirms differ — checking a stopped file replaces its source text
// with the upstream's current text, checking a file this project never had only
// brings one in. The server answers it because the mirror's file identity
// (`deterministicDownstreamFileId`) lives in the workers, where the parity test
// holds the two copies together.
// ──────────────────────────────────────────────────────────────────────────

sourceLinking.get("/:projectId/link-source/files", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string

  const role = await resolveProjectRoleIncludingArchived(c.env, user, projectId)
  if (!role) return c.json({ error: "not found or no access" }, 403)
  if (role.level < LINK_MIN_ROLE) {
    return c.json({ error: `role >= project_lead (${LINK_MIN_ROLE}) required` }, 403)
  }

  const project = await loadProjectWithSource(c.env, projectId)
  if (!project) return c.json({ error: "project not found" }, 404)
  const upstreamId = project.source_project_id
  if (!upstreamId) return c.json({ error: "project is not linked to a source" }, 409)

  const followed = await loadLinkFileIds(c.env, projectId)
  const upstreamFileIds = await loadUpstreamFileIds(c.env, upstreamId)
  const adoption = await loadLinkAdoption(c.env, projectId)
  const stoppedFileIds = await loadStoppedUpstreamFileIds(
    c.env, projectId, upstreamFileIds, followed, adoption?.files ?? null,
  )

  return c.json({ projectId, fileIds: followed, stoppedFileIds })
})

// ──────────────────────────────────────────────────────────────────────────
// POST /:projectId/link-source/files/stop  (AQU-1562)
//
// Stop this project following ONE of the upstream's files — the per-file
// counterpart of detach. Body: `{ fileIds: [<upstream file id>, …] }`.
//
// Nothing is copied, deleted or moved: the file stays in the project with the
// source text it has at this moment and every translation, validation and
// comment on it, and only leaves the link's selection. That is the whole
// operation, because the selection is what the mirror filters its fold by
// (sync-worker events/link-sync.ts, `fileFilter`) — an unfollowed file yields
// nothing to fold, so later upstream edits, renames and hide/show on it emit no
// mirror event, show nothing in "Upstream changes" and reach nothing here.
// Every other followed file keeps syncing, untouched.
//
// A whole-project link is MATERIALIZED first: it becomes a fixed list of the
// upstream's current files minus the stopped ones, which is AQU-1559's rule —
// so files the upstream gains later stop arriving on their own, and the client's
// confirm says so before this is called.
//
// At least one file must stay linked: "follow no files" is not a link (the same
// reasoning as the link request's own non-empty `fileIds`), and stopping
// everything is "Detach from source", which is a different, irreversible
// operation that snapshots the upstream first. A request that empties the
// selection is a 409, not a link that can never sync.
//
// Resuming is not here — checking a stopped file again is an ADD
// (POST /link-source/files), and the replay it runs is what brings the file to
// the upstream's current text, in the same file row: the downstream id is a
// pure function of (project, upstream file), so no second copy can appear.
// This route therefore has no inverse to write and no cursor to move.
//
// It does not re-check access to the upstream, unlike adding files. Stopping
// copies nothing in — it only reduces what this project takes — and a lead who
// has lost access to the upstream is exactly the person who needs it. Detach,
// the whole-project version, has never re-checked either.
// ──────────────────────────────────────────────────────────────────────────

const stopLinkFilesSchema = z.object({
  // Same bounds as the link request's own `fileIds`.
  fileIds: z.array(z.string().min(1).max(256)).min(1).max(5000),
})

sourceLinking.post(
  "/:projectId/link-source/files/stop",
  authMiddleware,
  zValidator("json", stopLinkFilesSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const { fileIds } = c.req.valid("json")

    const role = await resolveProjectRoleIncludingArchived(c.env, user, projectId)
    if (!role) return c.json({ error: "not found or no access" }, 403)
    if (role.level < LINK_MIN_ROLE) {
      return c.json({ error: `role >= project_lead (${LINK_MIN_ROLE}) required` }, 403)
    }

    const project = await loadProjectWithSource(c.env, projectId)
    if (!project) return c.json({ error: "project not found" }, 404)
    const upstreamId = project.source_project_id
    if (!upstreamId) return c.json({ error: "project is not linked to a source" }, 409)
    // A clone never syncs and a legacy link with no recorded mode is not
    // mirrored, so neither has a per-file flow of changes to stop.
    if (project.source_link_mode !== "live") {
      return c.json({ error: "only a live link can stop following a file" }, 409)
    }

    const stopSet = new Set(fileIds)
    // The upstream's current files, needed to materialize a whole-project link
    // into the fixed list the remaining files become.
    const upstreamFileIds = await loadUpstreamFileIds(c.env, upstreamId)

    let stopped: string[] = []
    let remaining: string[] = []
    let wasWholeProject = false
    let written = false
    for (let attempt = 0; attempt < 3 && !written; attempt++) {
      const current = await loadLinkFileIdsRaw(c.env, projectId)
      if (!current.ok) {
        // A database that predates migration 0127 has no selection to narrow.
        console.error(`link-source/files/stop: source_link_file_ids unreadable for ${projectId}`)
        return c.json({ error: "stopping a file is not available yet" }, 503)
      }
      const followed = parseLinkFileIds(current.raw)
      wasWholeProject = followed === null
      const materialized = followed ?? upstreamFileIds
      stopped = materialized.filter((id) => stopSet.has(id))
      remaining = materialized.filter((id) => !stopSet.has(id))

      // Nothing of what was asked is actually followed — already stopped, or
      // never followed. Answered as the no-op it is rather than refused: the
      // list the client sent was read a moment ago and the link can change.
      if (stopped.length === 0) {
        return c.json({ projectId, stopped: [], fileIds: followed, wasWholeProject })
      }
      if (remaining.length === 0) {
        return c.json(
          {
            error:
              "at least one file must stay linked; use detach-source to stop following the whole project",
          },
          409,
        )
      }

      try {
        const res = await c.env.AQUILLA_PG.prepare(
          `UPDATE projects SET source_link_file_ids = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND source_link_file_ids IS NOT DISTINCT FROM ?`,
        )
          .bind(JSON.stringify(remaining), projectId, current.raw)
          .run()
        written = Number(res.meta?.changes ?? 0) > 0
      } catch (err) {
        console.error("link-source/files/stop UPDATE failed:", err)
        return c.json({ error: "could not stop following those files" }, 500)
      }
    }
    if (!written) {
      return c.json({ error: "the link changed while stopping those files; try again" }, 409)
    }

    return c.json({ projectId, stopped, fileIds: remaining, wasWholeProject })
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
  // AQU-1559: read BEFORE the UPDATE below clears it — the snapshot that makes
  // this project self-contained must copy exactly the files the link followed.
  // A whole-project link reads as null and copies everything, as it always has,
  // and so does a database that predates migration 0127 (see `loadLinkFileIds`):
  // detach kept working before this slice and must keep working.
  const followedFileIds = await loadLinkFileIds(c.env, projectId)
  // AQU-1679: likewise read before it is cleared below — the snapshot has to
  // write a followed-into file's source onto that file, not into a new copy.
  const adoption = await loadLinkAdoption(c.env, projectId)

  // AQU-476: clear link metadata too — detach makes the project fully
  // self-contained (mode/consumes/gate no longer apply; cursor resets so
  // a future re-link starts clean).
  //
  // The three columns that arrived after the original link metadata
  // (`source_link_file_ids`, `source_link_lane_id`, `source_link_adopt`) are
  // cleared in the same statement when they exist. A database missing one of
  // them retries without only that column: dropping the lane because the file
  // list or the adoption column is absent would leave a detached project still
  // naming a lane. Tried fewest-omissions first, and every attempt that still
  // names the lane before any that drops it.
  const detachColumns = ["source_link_file_ids", "source_link_lane_id", "source_link_adopt"]
  const detachOmissions: ReadonlyArray<ReadonlyArray<string>> = [
    [],
    ["source_link_file_ids"],
    ["source_link_adopt"],
    ["source_link_file_ids", "source_link_adopt"],
    ["source_link_lane_id"],
    ["source_link_file_ids", "source_link_lane_id"],
    ["source_link_adopt", "source_link_lane_id"],
    ["source_link_file_ids", "source_link_lane_id", "source_link_adopt"],
  ]
  let detached = false
  let detachErr: unknown
  for (const omit of detachOmissions) {
    const dropped = new Set(omit)
    const assignments = [
      "source_project_id = NULL",
      "source_link_mode = NULL",
      "source_link_consumes = NULL",
      "source_link_gate = NULL",
      ...detachColumns.filter((col) => !dropped.has(col)).map((col) => `${col} = NULL`),
      "source_link_cursor = 0",
      "updated_at = CURRENT_TIMESTAMP",
    ]
    try {
      await c.env.AQUILLA_PG.prepare(
        `UPDATE projects SET ${assignments.join(", ")} WHERE id = ?`,
      )
        .bind(projectId)
        .run()
      detached = true
      break
    } catch (err) {
      detachErr = err
      if (!isPgUndefinedColumn(err)) break
    }
  }
  if (!detached) {
    console.error("detach-source UPDATE failed:", detachErr)
    return c.json({ error: "detach failed" }, 500)
  }

  // AQU-1560: a pending addition was for the link that just ended.
  await clearLinkBackfill(c.env, projectId)
  // AQU-1679: and so were the files it followed into.
  await clearLinkAdoption(c.env, projectId)

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
    onlyUpstreamFileIds: followedFileIds,
    adoptedFileIdOf: adoption?.files ?? null,
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
    console.error("project DELETE failed:", err)
    return c.json({ error: "delete failed" }, 500)
  }

  return c.json({ ok: true, projectId })
})

export default sourceLinking
