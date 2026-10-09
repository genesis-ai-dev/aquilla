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
//            `languageEditMinRole` floor (default project_lead 500 when the
//            org has not stored one — AQU-984) so project leads can correct a
//            wrong or reset language without also receiving AI config,
//            validation, or health. An explicit stored floor is kept.
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
import { ROLE_NAMES, resolveProjectRole } from "../services/project-permissions"
import { roleRequiredBody } from "../lib/role-denial"
import {
  getTermbaseEditMinRoleForProject,
  getOrgCountStructuralCellsForProject,
  getOrgAllowBulkValidateAiDraftsForProject,
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
  createTargetLane,
  readLaneLastChange,
  updateTargetLane,
  setTargetLaneArchived,
} from "../../../db/shared/lanes"
import {
  filterSettingsToVisibleLanes,
  READ_WALL_MAINTAINER,
  restoreHiddenLaneSettings,
} from "../../../src/lib/lanes/read-wall"
import { lanesForScopeVisibility } from "../../../src/lib/lanes/scope-ids"
import { loadTargetLaneIdentities, visibleTagsForMember } from "../../../db/shared/lane-visibility"
import { grantNewLane } from "../../../db/shared/lane-grants"
import type { AquillaDb } from "../../../db/shim/postgres"
import { laneLanguage } from "../../../src/lib/lanes/lane-display"
import { validateSettingsKeyValue } from "../../../db/shared/project-settings-keys"
import {
  includesRetiredLaneSettings,
  preserveRetiredLaneSettings,
  RETIRED_LANE_SETTINGS_MESSAGE,
} from "../../../db/shared/retired-lane-settings"

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
 * AQU-1086 / AQU-984: the project-language keys, gated by the org's
 * configurable `languageEditMinRole` (default project lead 500 when unset)
 * rather than the flat maintainer floor. The default target language and the
 * extra-lane registry are one scope on purpose: a lead who can change the
 * default target must be
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
 * AQU-1408: the interlinear alignment seeds — the ± pseudo-counts a member
 * writes by confirming (✓) or rejecting (✕) a word-alignment suggestion in the
 * BT tab. A write whose only *changed* key is this one is admitted at
 * contributor(400)+.
 *
 * Until this ticket the key rode the flat maintainer floor, which made the
 * panel's confirm/reject buttons a silently dead control for everyone below
 * 600: the click updated the in-memory model, the optimistic local apply was
 * (correctly) refused by the AQU-255 guard, and the seed never reached the
 * server — so the decision was gone on reload (Biblica ETT, 2026-09-24).
 *
 * Contributor is the floor because this is the same act as correcting a
 * back-translation, which `cell.backtranslation.set` already admits at
 * ROLE.CONTRIBUTOR: a person who writes the translation says what its words
 * mean. It hands them nothing else — every other key in the blob keeps the
 * maintainer gate above.
 */
const ALIGNMENT_SEEDS_KEY = "alignmentSeeds"
const ALIGNMENT_SEEDS_WRITE_MIN_ROLE = ROLE.CONTRIBUTOR

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
): Promise<ProjectSettingsResponse & {
  orgCountStructuralCells: boolean | null
  orgAllowBulkValidateAiDrafts: boolean | null
}> {
  const [orgCountStructuralCells, orgAllowBulkValidateAiDrafts] = await Promise.all([
    getOrgCountStructuralCellsForProject(env, projectId),
    getOrgAllowBulkValidateAiDraftsForProject(env, projectId),
  ])
  return { ...response, orgCountStructuralCells, orgAllowBulkValidateAiDrafts }
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
  let { visible, lanes } = await visibleTagsForMember(
    c.env.AQUILLA_PG, c.env.LANE_READ_WALL, projectId, user.id, role.level,
  )
  // AQU-1039: local and e2e leave the read wall off, but a member staffed on
  // one lane still must not be handed the other lanes. An unscoped member is
  // unchanged. Does not read lanes.language, so a row the backfill has not
  // filled yet filters the same way.
  //
  // AQU-1795: this runs whenever the wall left the caller unrestricted, wall
  // on or off, so it stops at the wall's own floor. A project lead who still
  // carries a scope row from before a promotion sees every lane, the same as
  // the sync worker's scopeReadClause and the portfolio give them.
  if (visible === null && role.level < READ_WALL_MAINTAINER) {
    const scoped = await laneScopeValuesFor(c.env.AQUILLA_PG, projectId, user.id)
    if (scoped.length > 0) {
      const identities = await loadTargetLaneIdentities(c.env.AQUILLA_PG, projectId)
      const limited = lanesForScopeVisibility(scoped, identities)
      visible = limited.visible
      lanes = [...limited.lanes]
    }
  }
  return c.json(await withOrgDefaults(c.env, projectId, filterSettingsToVisibleLanes(response, visible, lanes)))
})

async function laneScopeValuesFor(
  db: AquillaDb,
  projectId: string,
  userId: number,
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT value FROM project_member_scopes
        WHERE project_id = ? AND user_id = ? AND kind = 'lane'`,
    )
    .bind(projectId, userId)
    .all<{ value: string }>()
  return (rows.results ?? []).map((row) => row.value)
}

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
    // AQU-1595: the four language keys are lane rows, not settings. The same
    // list and message the external commands use. An echo of a stored key is
    // still "includes" — the client omits them, and the write below copies the
    // stored values back so the blob is not rewritten.
    if (includesRetiredLaneSettings(body.settings)) {
      return c.json({ error: RETIRED_LANE_SETTINGS_MESSAGE }, 400)
    }
    // AQU-1750: the caller's read-wall view, the same one its GET used. It
    // decides what the write may change and what every response may show.
    const { visible, lanes } = await visibleTagsForMember(
      c.env.AQUILLA_PG, c.env.LANE_READ_WALL, projectId, user.id, role.level,
    )
    const stored = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
    let settings = preserveRetiredLaneSettings(stored.settings, body.settings)
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
      // AQU-1750: behind the read wall this caller's body is an echo of a
      // filtered GET. Put back the lanes and primary language it could not
      // see before diffing, so the echo neither deletes them nor turns a
      // one-key carve-out write into a language write. The retired keys were
      // already copied back from the stored row above (AQU-1595), so for them
      // this is a no-op; it stays as the wall's own guard. A client's
      // ifMatchVersion comes from an earlier read, so it is never newer than
      // `stored`: the version guard below saves onto this row or answers 409.
      const restored = restoreHiddenLaneSettings(stored.settings, settings, visible, lanes)
      if (!restored.ok) return c.json({ error: restored.error }, 403)
      settings = restored.settings
      const changed = changedSettingsKeys(stored.settings, settings)
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
      const alignmentSeedsOnly = changed.length > 0
        && changed.every((key) => key === ALIGNMENT_SEEDS_KEY)
      if (
        !terminologyOnly && !languageOnly && !autopilotOnly
        && !countStructuralOnly && !alignmentSeedsOnly
      ) {
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
          return c.json(languageWriteDenial(languageFloor, role), 403)
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
      } else if (alignmentSeedsOnly) {
        // AQU-1408: server-enforced, not merely a client floor — the panel's
        // confirm/reject buttons are visible to the whole project, so the
        // answer to "may this decision be saved?" has to be the same one the
        // client shows.
        if (role.level < ALIGNMENT_SEEDS_WRITE_MIN_ROLE) {
          return c.json(
            {
              error: `role >= contributor (${ALIGNMENT_SEEDS_WRITE_MIN_ROLE}) required to confirm or reject word alignments`,
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

    // AQU-1686: `bibleEnrichments` holds only known enrichment ids with boolean
    // values, the rule the Agent API already applies. Without it this route
    // stored anything ({voices: "off"} went in with 200), and the settings card
    // showed a stored string as a switch that is on. The client sends the whole
    // settings object on every save, so a value already stored is let through
    // unchanged: a project carrying an older bad value can still save the rest.
    const rawEnrichments = (body.settings as Record<string, unknown>).bibleEnrichments
    if (rawEnrichments !== undefined) {
      const problem = validateSettingsKeyValue("bibleEnrichments", rawEnrichments)
      if (problem) {
        const before = stored.settings.bibleEnrichments
        if (JSON.stringify(before) !== JSON.stringify(rawEnrichments)) {
          return c.json({ error: problem }, 400)
        }
      }
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
      settings,
      ifMatchVersion,
      updatedBy: user.id,
      blobs: c.env.SNAPSHOTS ?? null,
      r2KeyPrefix: c.env.R2_KEY_PREFIX,
    })

    // AQU-1750: both bodies are filtered exactly like the GET. The client
    // keeps either one as server truth, so an unfiltered row would show a
    // caller behind the wall the lanes and primary language its GET hides.
    if (result.status === "conflict") {
      return c.json(
        {
          error: "version mismatch",
          current: await withOrgDefaults(
            c.env, projectId, filterSettingsToVisibleLanes(result.current, visible, lanes),
          ),
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
    // recovered by the existing focus/reconnect settings read. Downstream
    // projects the link just copied into get the same nudge.
    const notifyPromise = Promise.all([
      notifySyncWorkerOfProjectSettingsChange(c.env, projectId, fresh.version),
      ...(result.propagated ?? []).map((copy) =>
        notifySyncWorkerOfProjectSettingsChange(c.env, copy.projectId, copy.version),
      ),
    ])
    try {
      c.executionCtx.waitUntil(notifyPromise)
    } catch {
      // Hono's direct test harness has no ExecutionContext. The notification
      // remains best-effort there just as it is in a deployed Worker.
      void notifyPromise
    }
    // `lanes` predates the write. A lane the write minted carries no grant,
    // so the newer list would hide exactly the same labels.
    return c.json(
      await withOrgDefaults(c.env, projectId, filterSettingsToVisibleLanes(fresh, visible, lanes)),
    )
  },
)

// AQU-1592: the languages screen edits a lane's identity — the language it
// translates into, an optional display name, an optional code override. Every
// field is optional on PATCH so a client may send just the one it changed; a
// client that predates AQU-1592 sends `name` alone, which still means "rename".
const renameLaneSchema = z.object({
  name: z.string().nullable().optional(),
  language: z.string().optional(),
  code: z.string().nullable().optional(),
})

const createLaneSchema = z.object({
  name: z.string(),
  language: z.string(),
  code: z.string().nullable().optional(),
  /**
   * AQU-1784: the languages screen warns inline when the new lane's display
   * name duplicates an active lane's and then sends this, so the save goes
   * through instead of coming back 409. Absent means the old refusal, which
   * is what every other create path (project creation, the org's add-language
   * popover, the sibling merge) still gets.
   */
  allowDuplicateName: z.boolean().optional(),
})

const archiveLaneSchema = z.object({
  archived: z.boolean(),
})

/**
 * Same floor as a language-only settings write, lanes included: the org's
 * languageEditMinRole, or PROJECT_LEAD when that key was never set.
 */
function languageWriteDenial(
  floor: number,
  role: { level: number; source?: string | null },
) {
  const name = (ROLE_NAMES[floor] ?? `role ${floor}`).replaceAll("_", " ")
  return roleRequiredBody(
    `${name} or higher is required to change this project's languages`,
    floor,
    role,
  )
}

async function denyLanguageWrite(
  env: AuthHonoEnv["Bindings"],
  user: AuthUser,
  projectId: string,
) {
  const role = await resolveProjectRole(env, user, projectId)
  if (!role) return { error: "no access to project" }
  const floor = await getLanguageEditMinRoleForProject(env, projectId)
  if (role.level < floor) return languageWriteDenial(floor, role)
  return null
}

/** Add or remove one tag in targetLanes / archivedLanes, bumping the version. */
export async function mergeSettingsArray(
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

/**
 * AQU-1816: a lane-row write relays to the project DO the way the settings
 * PATCH and the archive route already do, so a workspace open in another tab
 * (or for another member) lists the new or renamed lane without a reload.
 * Best-effort, like the other relays: `executionCtx` is absent in some test
 * harnesses, and the correctness path is the client's own re-read.
 */
function notifySettingsChangedBestEffort(
  c: {
    env: Parameters<typeof notifySyncWorkerOfProjectSettingsChange>[0]
    executionCtx: { waitUntil(promise: Promise<unknown>): void }
  },
  projectId: string,
  version: number,
): void {
  const notifyPromise = notifySyncWorkerOfProjectSettingsChange(c.env, projectId, version)
  try {
    c.executionCtx.waitUntil(notifyPromise)
  } catch {
    void notifyPromise
  }
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
    // Only a real `legacy_tag ''` row is the old default. A missing row must
    // not borrow settings.targetLanguage — that would tag the new lane with
    // its id instead of its language, which is how the first target of a new
    // project used to become `''`.
    const defaultLane = (current.lanes ?? []).find(
      (lane) => lane.role === "target" && lane.legacyTag === "",
    )
    const resolvedDefault = defaultLane
      ? laneLanguage(defaultLane, {
          settings: current.settings,
          role: "target",
          legacyTag: "",
        })
      : ""
    const targetLanguage = resolvedDefault || null
    let created: Awaited<ReturnType<typeof createTargetLane>>
    try {
      created = await createTargetLane(c.env.AQUILLA_PG, projectId, {
        name: body.name,
        language: body.language,
        code: body.code,
        allowDuplicateName: body.allowDuplicateName === true,
        targetLanguage,
        existing: (current.lanes ?? []).map((lane) => ({
          id: lane.id,
          name: lane.name,
          language: lane.language,
          legacyTag: lane.legacyTag,
        })),
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return c.json({ error: `write failed: ${message}` }, 500)
    }
    if (!created.ok) {
      const status = created.problem === "duplicate" ? 409 : 400
      const error = created.problem === "duplicate" ? "duplicate_name" : created.problem
      return c.json({ error }, status)
    }
    // AQU-1781: under the read wall a member below Maintainer sees only the
    // lanes they hold a grant for, so a lane nobody is granted is invisible to
    // every unscoped contributor while the inspector still calls them
    // "Unscoped — full access". Grant it in the same request that creates it.
    try {
      await grantNewLane(c.env.AQUILLA_PG, projectId, { laneId: created.laneId }, user.id)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return c.json({ error: `write failed: ${message}` }, 500)
    }
    // AQU-1594: the lane row is the registry. Do not mirror the tag into
    // settings.targetLanes.
    const fresh = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
    notifySettingsChangedBestEffort(c, projectId, fresh.version)
    const lane = fresh.lanes?.find((row) => row.id === created.laneId) ?? null
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
    const body = c.req.valid("json")
    const result = await updateTargetLane(c.env.AQUILLA_PG, projectId, laneId, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.language === undefined ? {} : { language: body.language }),
      ...(body.code === undefined ? {} : { code: body.code }),
    })
    if (result.status === "not_found") return c.json({ error: "lane not found" }, 404)
    if (result.status === "duplicate") {
      return c.json({ error: "duplicate_name" }, 409)
    }
    if (
      result.status === "empty" ||
      result.status === "too_long" ||
      result.status === "malformed_code"
    ) {
      return c.json({ error: result.status }, 400)
    }
    if (result.status !== "ok") return c.json({ error: result.status }, 400)
    const fresh = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
    notifySettingsChangedBestEffort(c, projectId, fresh.version)
    return c.json({ lane: fresh.lanes?.find((row) => row.id === laneId) ?? result.lane })
  },
)

// AQU-1464: "is anyone still working in this lane?" — read by the archive
// confirmation dialog before a PM locks the lane (AQU-1462 / AQU-1463 made
// archiving a hard write-lock, so archiving a busy lane interrupts a translator
// mid-session).
//
// Gated by the SAME `denyLanguageWrite` floor as archiving itself: whoever may
// archive a lane may see when it was last touched, and nobody below that floor
// can read a member's name and activity time out of it. A Contributor gets 403,
// which is also why the client never has to hide the value itself.
projectSettings.get("/:projectId/lanes/:laneId/last-change", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const laneId = c.req.param("laneId") as string
  const denied = await denyLanguageWrite(c.env, user, projectId)
  if (denied) return c.json(denied, 403)
  // Confirm the lane is real first, so an unknown id reads as 404 rather than
  // as the indistinguishable "this lane has never been edited".
  const current = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
  const lane = (current.lanes ?? []).find((row) => row.id === laneId && row.role === "target")
  if (!lane) return c.json({ error: "lane not found" }, 404)
  try {
    const lastChange = await readLaneLastChange(c.env.AQUILLA_PG, projectId, laneId)
    return c.json({ lastChange })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return c.json({ error: `read failed: ${message}` }, 500)
  }
})

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
    // AQU-1600: the former default lane archives like any other lane. The only
    // refusal left is the last active one — a project must keep at least one
    // non-archived target lane.
    if (result.status === "last_lane") return c.json({ error: "last_lane" }, 400)
    const tag = result.lane.legacyTag ?? ""
    // The legacy `settings.archivedLanes` mirror holds TAGS, and the former
    // default lane's tag is '' — which that array cannot name (every reader
    // filters the empty string out). Its `lanes.archived_at` row is the only
    // record of its archived state, so skip the mirror rather than push a ''
    // entry no reader would honour.
    if (tag !== "") {
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
    }
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
