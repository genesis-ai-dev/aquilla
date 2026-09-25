// Project settings routes — versioned JSON blob with optimistic-concurrency
// control (Aquilla spec 03-data-model.md §"Project Settings"). Mounted at
// /api/v2/projects in src/index.ts; sub-paths:
//
//   GET  /:projectId/settings        any project member
//   PUT  /:projectId/settings        maintainer (600)+ per AD-6
//   PATCH /:projectId/settings       compatibility alias for older web builds
//
// Writes require `ifMatchVersion` (query string or header). On mismatch the
// response is 409 with the current row attached so the client can show
// "settings changed elsewhere — refresh and reapply." On match we run a
// single atomic UPDATE that re-checks the version inside the WHERE clause —
// meta.changes == 0 means a concurrent writer landed first and we 409 with
// the now-stored row.
//
// Settings keys (all optional per spec): sourceLanguage, targetLanguage,
// systemPrompt, rules, rulePenalties, decaySettings, validationCount,
// validationCountAudio. We don't enforce the key set here — the server is
// a dumb store, the client owns the shape. The spec note about
// `targetLanguage` left unset identifying a source-only project (AD-9) is
// purely a downstream interpretation.
//
// THREE keys are permission-scoped rather than dumb-stored:
//
//   AQU-822  `terminology` (the project's termbase concepts). A write whose
//            only *changed* key is `terminology` is gated by the org's
//            configurable `termbaseEditMinRole` floor (default project_lead
//            500) instead of the maintainer floor below, so an org can let its
//            translators own terminology without also handing them AI config,
//            health thresholds, or languages.
//   AQU-1086 the project-language keys (`sourceLanguage`, `targetLanguage`,
//            `targetLanes`, `archivedLanes`). A write whose only *changed*
//            keys are language keys is gated by the org's configurable
//            `languageEditMinRole` floor (default maintainer 600, i.e. today's
//            behaviour) so an org can let its project leads correct a wrong or
//            reset language without also handing them AI config, validation,
//            or health.
//   AQU-1246 `autopilotEnabled` (the project-wide opt-in to the experimental
//            Autopilot surface). An autopilot-only write is admitted at
//            project_lead 500 — whether your own project tries an experiment
//            is a lead's call.
//
// Everything else keeps the maintainer gate, unchanged. All three carve-outs
// are scoped to a write that changes NOTHING ELSE, so none widens access to
// any other key.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE, type AuthUser } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import {
  getTermbaseEditMinRoleForProject,
  getOrgCountStructuralCellsForProject,
  getLanguageEditMinRoleForProject,
} from "../services/org-permissions"
import { notifySyncWorkerOfProjectSettingsChange } from "../services/sync-worker-notify"
import {
  loadProjectSettings,
  patchProjectSettingsShared,
  updateProjectSettingsShared,
  type ProjectSettingsResponse,
} from "../../../db/shared/projects"
import {
  insertTargetLane,
  renameTargetLane,
  setTargetLaneArchived,
} from "../../../db/shared/lanes"
import { planNewTargetLane } from "../../../src/lib/lanes/lane-create"
import { newLaneId } from "../../../src/lib/lanes/lane-id"
import type { AquillaDb } from "../../../db/shim/postgres"

const projectSettings = new Hono<AuthHonoEnv>()

// Minimum role allowed to write settings — `maintainer` per the spec
// (project-configuration stories: name-and-configure-project,
// customize-ai-settings, monitor-project-health, validate-translation).
const SETTINGS_WRITE_MIN_ROLE = ROLE.MAINTAINER

/** The termbase key — its own (org-configurable) write floor. */
const TERMINOLOGY_KEY = "terminology"

/**
 * AQU-1083: this project's override for whether headings count toward
 * progress. ABSENT means inherit the org's value — there is no third stored
 * state, so "use the organization default" is expressed by deleting the key,
 * not by writing null.
 *
 * Leads may set it. It decides how this project's own numbers are calculated,
 * which is squarely the job of whoever runs the project, and it changes nothing
 * about who may see or do anything.
 */
const COUNT_STRUCTURAL_KEY = "countStructuralCells"
const COUNT_STRUCTURAL_MIN_ROLE = ROLE.PROJECT_LEAD

/**
 * AQU-1086: the project-language keys, gated by the org's configurable
 * `languageEditMinRole` (default maintainer 600) rather than the flat
 * maintainer floor. The default target language and the extra-lane registry
 * are one scope on purpose: a lead who can change the default target must be
 * able to add/archive a lane too, or the Project Info and Languages cards
 * disagree (AQU-898).
 */
const LANGUAGE_KEYS = new Set([
  "sourceLanguage",
  "targetLanguage",
  "targetLanes",
  "archivedLanes",
])

/**
 * AQU-1246: the project-wide opt-in to the experimental Autopilot surface.
 * A write whose only *changed* key is this one is admitted at
 * project_lead(500)+.
 *
 * Before this ticket the whole gate was a device-local browser switch, so any
 * member of any project could reveal the experiment in one click and the
 * choice never left their machine. Moving it here makes it a project decision
 * with a real floor, and lets it be flipped for a project without a client
 * deploy. Admitting the key does NOT widen anything else: every other key in
 * the blob keeps the maintainer gate above.
 */
const AUTOPILOT_KEY = "autopilotEnabled"
const AUTOPILOT_WRITE_MIN_ROLE = ROLE.PROJECT_LEAD

/**
 * Top-level settings keys whose value differs between the stored blob and an
 * incoming write. Compared on the CHANGE, not on presence: the client patch
 * is a whole-object read-modify-write, so every write echoes back every key
 * it didn't touch — treating presence as a change would make the
 * terminology carve-out below unreachable in practice.
 *
 * Values are compared by JSON serialization. Echoed keys round-trip through
 * `JSON.parse` of the stored blob, so nested key order is preserved and this
 * is stable for the read-modify-write path; a re-ordered nested object would
 * read as "changed" and simply fall back to the maintainer gate (fail-safe,
 * never fail-open).
 */
export function changedSettingsKeys(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)])
  const changed: string[] = []
  for (const key of keys) {
    if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) changed.push(key)
  }
  return changed
}

/**
 * AQU-1083: attach the org-level defaults this project inherits.
 *
 * Applied to EVERY settings response, the 409 body included — a client that
 * conflicts snaps its whole state to `current`, so a body without this field
 * would silently drop the org default and the project's control would start
 * claiming the wrong thing about what "Organization default" means.
 */
async function withOrgDefaults(
  env: AuthHonoEnv["Bindings"],
  projectId: string,
  response: ProjectSettingsResponse,
): Promise<ProjectSettingsResponse & { orgCountStructuralCells: boolean | null }> {
  return {
    ...response,
    orgCountStructuralCells: await getOrgCountStructuralCellsForProject(env, projectId),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/projects/:projectId/settings
// ──────────────────────────────────────────────────────────────────────────

projectSettings.get("/:projectId/settings", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string

  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)

  const response = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
  return c.json(await withOrgDefaults(c.env, projectId, response))
})

// ──────────────────────────────────────────────────────────────────────────
// PUT/PATCH /api/v2/projects/:projectId/settings
//
// Body shape:
//   { settings: object, ifMatchVersion?: number }
//
// `ifMatchVersion` may also be supplied via:
//   - query string ?ifMatchVersion=N
//   - header `If-Match-Version: N`
//
// The version-match check is server-authoritative: even if a client sends
// no version, we still require one — there's no "force write" path. The
// 409 response includes the current stored row so the client can rebase.
// ──────────────────────────────────────────────────────────────────────────

const updateSettingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
  ifMatchVersion: z.number().int().nonnegative().optional(),
})

function parseIntOrNull(s: string | undefined): number | null {
  if (s == null) return null
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

projectSettings.on(
  ["PUT", "PATCH"],
  "/:projectId/settings",
  authMiddleware,
  zValidator("json", updateSettingsSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const body = c.req.valid("json")

    const role = await resolveProjectRole(c.env, user, projectId)
    if (!role) return c.json({ error: "no access to project" }, 403)
    if (role.level < SETTINGS_WRITE_MIN_ROLE) {
      // AQU-822 / AQU-1086: below the maintainer floor, the ONLY writes
      // allowed are a terminology-only one (gated by the org's configured
      // termbaseEditMinRole) or a language-only one (gated by the org's
      // configured languageEditMinRole). Any other changed key falls through
      // to the maintainer 403 — lowering either floor must never widen write
      // access to AI config, health, validation, or anything else.
      //
      // The scopes are tested in this order because a no-op write (nothing
      // changed) satisfies both vacuously; keeping terminology first preserves
      // the pre-AQU-1086 behaviour for that case exactly.
      const stored = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
      const changed = changedSettingsKeys(stored.settings, body.settings)
      // Each carve-out is key-exact and carries its own floor. A write that
      // touches anything else — even alongside a permitted key — falls through
      // to the maintainer 403, so widening one of these can never widen access
      // to AI config, health, languages, or the rest.
      // terminologyOnly/languageOnly are deliberately NOT guarded by
      // `changed.length > 0` — a no-op write (nothing changed) satisfies both
      // vacuously, and checking terminology first below preserves the
      // pre-AQU-1086 behaviour for that case exactly (a read-modify-write
      // client always echoes every key it didn't touch).
      const terminologyOnly = changed.every((key) => key === TERMINOLOGY_KEY)
      const languageOnly = changed.every((key) => LANGUAGE_KEYS.has(key))
      const autopilotOnly = changed.length > 0
        && changed.every((key) => key === AUTOPILOT_KEY)
      const countStructuralOnly = changed.length > 0
        && changed.every((key) => key === COUNT_STRUCTURAL_KEY)
      if (!terminologyOnly && !languageOnly && !autopilotOnly && !countStructuralOnly) {
        return c.json(
          { error: `role >= maintainer (${SETTINGS_WRITE_MIN_ROLE}) required` },
          403,
        )
      }
      if (terminologyOnly) {
        const termbaseFloor = await getTermbaseEditMinRoleForProject(c.env, projectId)
        if (role.level < termbaseFloor) {
          return c.json(
            {
              error: `role >= ${termbaseFloor} required to manage this project's termbase (org termbaseEditMinRole)`,
            },
            403,
          )
        }
      } else if (languageOnly) {
        const languageFloor = await getLanguageEditMinRoleForProject(c.env, projectId)
        if (role.level < languageFloor) {
          return c.json(
            {
              error: `role >= ${languageFloor} required to change this project's languages (org languageEditMinRole)`,
            },
            403,
          )
        }
      } else if (autopilotOnly) {
        // AQU-1246: this is the gate that decides whether the experimental
        // Autopilot surface exists for the project at all. A lead owns that
        // call for their own project; nobody below does. The check is here,
        // not only in the client, because a hidden toggle is not a permission
        // — the acceptance criterion is explicitly server-enforced.
        if (role.level < AUTOPILOT_WRITE_MIN_ROLE) {
          return c.json(
            { error: `role >= project_lead (${AUTOPILOT_WRITE_MIN_ROLE}) required to change the Autopilot opt-in` },
            403,
          )
        }
      } else if (countStructuralOnly) {
        if (role.level < COUNT_STRUCTURAL_MIN_ROLE) {
          return c.json(
            {
              error: `role >= project lead (${COUNT_STRUCTURAL_MIN_ROLE}) required to change whether headings count toward progress`,
            },
            403,
          )
        }
      }
    }

    // Boolean or absent. Absent is "inherit the org", so there is no null case
    // to accept — writing one would store a third state the resolver does not
    // have a meaning for.
    const rawCountStructural = (body.settings as Record<string, unknown>)[COUNT_STRUCTURAL_KEY]
    if (rawCountStructural !== undefined && typeof rawCountStructural !== "boolean") {
      return c.json({ error: `${COUNT_STRUCTURAL_KEY} must be a boolean` }, 400)
    }

    const queryVersion = parseIntOrNull(c.req.query("ifMatchVersion"))
    const headerVersion = parseIntOrNull(c.req.header("If-Match-Version"))
    const ifMatchVersion =
      body.ifMatchVersion ?? queryVersion ?? headerVersion

    if (ifMatchVersion == null) {
      return c.json(
        {
          error:
            "ifMatchVersion required (body, query, or If-Match-Version header)",
        },
        400,
      )
    }

    // Row-write domain logic (version pre-check, first-write INSERT vs
    // version-guarded UPDATE, validation-threshold reprojection) is shared with
    // sync-worker's receipt-only UpdateProjectSettings command
    // (db/shared/projects.ts). The route keeps only HTTP concerns: role gate,
    // ifMatchVersion extraction, status mapping, and the best-effort notify.
    const result = await updateProjectSettingsShared(c.env.AQUILLA_PG, {
      projectId,
      settings: body.settings,
      ifMatchVersion,
      updatedBy: user.id,
    })

    if (result.status === "conflict") {
      return c.json(
        {
          error: "version mismatch",
          current: await withOrgDefaults(c.env, projectId, result.current),
        },
        409,
      )
    }
    if (result.status === "error") {
      return c.json({ error: `write failed: ${result.message}` }, 500)
    }

    const fresh = result.settings
    // Settings live in identity while connected editor clients listen to the
    // project sync DO. This is a best-effort acceleration: a missed frame is
    // recovered by the existing focus/reconnect settings read.
    const notifyPromise = notifySyncWorkerOfProjectSettingsChange(c.env, projectId, fresh.version)
    try {
      c.executionCtx.waitUntil(notifyPromise)
    } catch {
      // Hono's direct test harness has no ExecutionContext. The notification
      // remains best-effort there just as it is in a deployed Worker.
      void notifyPromise
    }
    return c.json(await withOrgDefaults(c.env, projectId, fresh))
  },
)

const renameLaneSchema = z.object({
  name: z.string(),
})

const createLaneSchema = z.object({
  name: z.string(),
  language: z.string(),
})

const archiveLaneSchema = z.object({
  archived: z.boolean(),
})

/**
 * Same floor as a language-only settings write: maintainer by default, or the
 * org's languageEditMinRole when that org let project leads edit languages.
 */
async function denyLanguageWrite(
  env: AuthHonoEnv["Bindings"],
  user: AuthUser,
  projectId: string,
): Promise<{ error: string } | null> {
  const role = await resolveProjectRole(env, user, projectId)
  if (!role) return { error: "no access to project" }
  const floor = await getLanguageEditMinRoleForProject(env, projectId)
  if (role.level < floor) {
    return { error: `role >= ${floor} required to change this project's languages` }
  }
  return null
}

/** Add or remove one tag in targetLanes / archivedLanes, bumping the version. */
async function mergeSettingsArray(
  db: AquillaDb,
  projectId: string,
  userId: number,
  key: "targetLanes" | "archivedLanes",
  tag: string,
  present: boolean,
): Promise<"ok" | "conflict" | "error"> {
  if (!tag) return "ok"
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await loadProjectSettings(db, projectId)
    const raw = current.settings[key]
    const list = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : []
    const has = list.includes(tag)
    if (has === present) return "ok"
    const next = present ? [...list, tag] : list.filter((item) => item !== tag)
    const result = await patchProjectSettingsShared(db, {
      projectId,
      ops: [{ key, value: next }],
      ifMatchVersion: current.version,
      updatedBy: userId,
    })
    if (result.status === "ok") return "ok"
    if (result.status === "conflict") continue
    return "error"
  }
  return "conflict"
}

// AQU-1418: lane rows are what the screen edits. The settings string registry
// stays in step so events, the external API, and older clients still resolve
// a lane by its legacy tag. The id is never shown. A duplicate display name
// is refused; the database does not have a unique constraint on name.
projectSettings.post(
  "/:projectId/lanes",
  authMiddleware,
  zValidator("json", createLaneSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const denied = await denyLanguageWrite(c.env, user, projectId)
    if (denied) return c.json(denied, 403)
    const body = c.req.valid("json")
    const current = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
    const targetLanguage =
      typeof current.settings.targetLanguage === "string" ? current.settings.targetLanguage : null
    const laneId = newLaneId()
    const plan = planNewTargetLane({
      laneId,
      name: body.name,
      language: body.language,
      targetLanguage,
      existing: (current.lanes ?? []).map((lane) => ({
        id: lane.id,
        name: lane.name,
        legacyTag: lane.legacyTag,
      })),
    })
    if (!plan.ok) {
      const status = plan.problem === "duplicate" ? 409 : 400
      const error = plan.problem === "duplicate" ? "duplicate_name" : plan.problem
      return c.json({ error }, status)
    }
    try {
      await insertTargetLane(c.env.AQUILLA_PG, projectId, {
        id: laneId,
        name: plan.name,
        langCode: plan.langCode,
        legacyTag: plan.legacyTag,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return c.json({ error: `write failed: ${message}` }, 500)
    }
    const synced = await mergeSettingsArray(
      c.env.AQUILLA_PG,
      projectId,
      user.id,
      "targetLanes",
      plan.legacyTag,
      true,
    )
    if (synced === "conflict") return c.json({ error: "version mismatch" }, 409)
    if (synced === "error") return c.json({ error: "write failed" }, 500)
    const fresh = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
    const notifyPromise = notifySyncWorkerOfProjectSettingsChange(c.env, projectId, fresh.version)
    try {
      c.executionCtx.waitUntil(notifyPromise)
    } catch {
      void notifyPromise
    }
    const lane = fresh.lanes?.find((row) => row.id === laneId) ?? null
    return c.json({ lane }, 201)
  },
)

projectSettings.patch(
  "/:projectId/lanes/:laneId",
  authMiddleware,
  zValidator("json", renameLaneSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const laneId = c.req.param("laneId") as string
    const denied = await denyLanguageWrite(c.env, user, projectId)
    if (denied) return c.json(denied, 403)
    const result = await renameTargetLane(
      c.env.AQUILLA_PG,
      projectId,
      laneId,
      c.req.valid("json").name,
    )
    if (result.status === "not_found") return c.json({ error: "lane not found" }, 404)
    if (result.status === "duplicate") {
      return c.json({ error: "duplicate_name" }, 409)
    }
    if (result.status === "empty" || result.status === "too_long") {
      return c.json({ error: result.status }, 400)
    }
    if (result.status !== "ok") return c.json({ error: result.status }, 400)
    return c.json({ lane: result.lane })
  },
)

projectSettings.post(
  "/:projectId/lanes/:laneId/archive",
  authMiddleware,
  zValidator("json", archiveLaneSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const laneId = c.req.param("laneId") as string
    const denied = await denyLanguageWrite(c.env, user, projectId)
    if (denied) return c.json(denied, 403)
    const archived = c.req.valid("json").archived
    const result = await setTargetLaneArchived(c.env.AQUILLA_PG, projectId, laneId, archived)
    if (result.status === "not_found") return c.json({ error: "lane not found" }, 404)
    if (result.status === "default_lane") return c.json({ error: "default_lane" }, 400)
    const tag = result.lane.legacyTag ?? ""
    const synced = await mergeSettingsArray(
      c.env.AQUILLA_PG,
      projectId,
      user.id,
      "archivedLanes",
      tag,
      archived,
    )
    if (synced === "conflict") return c.json({ error: "version mismatch" }, 409)
    if (synced === "error") return c.json({ error: "write failed" }, 500)
    const fresh = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
    const notifyPromise = notifySyncWorkerOfProjectSettingsChange(c.env, projectId, fresh.version)
    try {
      c.executionCtx.waitUntil(notifyPromise)
    } catch {
      void notifyPromise
    }
    return c.json({ lane: fresh.lanes?.find((row) => row.id === laneId) ?? result.lane })
  },
)

export default projectSettings
