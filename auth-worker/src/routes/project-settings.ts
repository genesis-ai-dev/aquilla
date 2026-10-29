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
// One key is REFUSED rather than stored:
//
//   AQU-1724 `terminology`, retired. Key terms live in the `concepts` table,
//            written with term.* events; the editor never reads this key on a
//            migrated project. A write that CHANGES it — sets, edits or drops
//            it — is a 400 pointing to term.* events, for every role. An echo
//            of the stored value is not a change and passes. (AQU-822 used to
//            give it its own `termbaseEditMinRole` floor.)
//
// One key is also SIZE-capped:
//
//   AQU-1943 `ttsSettings`. The voice library and cast-assignment map are
//            refused with 422 beyond the ceiling in
//            db/shared/tts-settings-caps.ts, because every member re-reads
//            this blob on workspace open and on focus. Judged on the change,
//            so an already-over project can still save the rest and can still
//            write the prune that brings it under.
//
// These keys are permission-scoped rather than dumb-stored:
//
//   AQU-1246 `autopilotEnabled` (the project-wide opt-in to the experimental
//            Autopilot surface). An autopilot-only write is admitted at
//            project_lead 500 — whether your own project tries an experiment
//            is a lead's call.
//   AQU-2041 `ttsSettings`, only when the stored `projectLeadsManageVoices`
//            flag is on. A project lead may then change voices, per-lane cast,
//            and per-lane defaults on lanes they can write. The flag itself
//            stays maintainer-only and defaults off. A save that rewrites a
//            hidden lane's voices is refused.
//
// Everything else keeps the maintainer gate, unchanged. Each carve-out is
// scoped to a write that changes NOTHING ELSE, so none widens access to any
// other key.
//
// AQU-1771: `rosterViewMinRole` and `memberProgressViewMinRole` are this
// project's own, stricter-only copies of the org's visibility floors. They
// keep the maintainer gate (org owners reach it through their org role), are
// refused below the org's floor, and only a caller at or above a stored value
// may lower or remove it — see visibilityFloorWriteRefusal.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { pushDirtyLinksAfterResponse } from "../lib/integrations/push"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { leadMaySaveTtsSettings, incomingRewritesHiddenVoices } from "../../../src/lib/lanes/voice-wall"
import { ROLE, type AuthUser } from "../types"
import { ROLE_NAMES, resolveProjectRole } from "../services/project-permissions"
import { roleRequiredBody, type RoleRequiredBody } from "../lib/role-denial"
import {
  getTermbaseEditMinRoleForProject,
  getOrgCountStructuralCellsForProject,
  getLanguageEditMinRoleForProject,
  getProjectOrgPolicy,
  type ProjectOrgPolicy,
} from "../services/org-permissions"
import {
  parseProjectVisibilityFloor,
  VISIBILITY_FLOOR_KEYS,
  VISIBILITY_FLOOR_LEVELS,
  type VisibilityFloorKey,
} from "../../../db/shared/visibility-floors"
import { notifySyncWorkerOfProjectSettingsChange } from "../services/sync-worker-notify"
import {
  loadProjectSettings,
  updateProjectSettingsShared,
  type ProjectSettingsResponse,
} from "../../../db/shared/projects"
import {
  RETIRED_TERMINOLOGY_KEY,
  RETIRED_TERMINOLOGY_MESSAGE,
} from "../../../db/shared/project-settings-keys"
import {
  createTargetLane,
  readLaneLastChange,
  updateTargetLane,
  setTargetLaneArchived,
  setTargetLaneDelivers,
  setTargetLaneRecordsAudio,
} from "../../../db/shared/lanes"
import { LANE_DELIVERS } from "../../../src/lib/lanes/lane-delivers"
import {
  filterSettingsToVisibleLanes,
  READ_WALL_MAINTAINER,
  restoreHiddenLaneSettings,
} from "../../../src/lib/lanes/read-wall"
import { lanesForScopeVisibility } from "../../../src/lib/lanes/scope-ids"
import { loadTargetLaneIdentities, visibleTagsForMember } from "../../../db/shared/lane-visibility"
import { grantNewLane } from "../../../db/shared/lane-grants"
import { grantCreatedLaneToActor } from "../services/lane-grants"
import { markProjectSyncLinksDirty } from "../../../db/shared/progress-sync-dirty"
import type { AquillaDb } from "../../../db/shim/postgres"
import { laneLanguage } from "../../../src/lib/lanes/lane-display"
import { validateSettingsKeyValue } from "../../../db/shared/project-settings-keys"
import {
  includesRetiredLaneSettings,
  preserveRetiredLaneSettings,
  RETIRED_LANE_SETTINGS_MESSAGE,
} from "../../../db/shared/retired-lane-settings"
import { loadOrgValidationDefaults } from "../../../db/shared/validation-threshold"
import { ttsSettingsCapProblem } from "../../../db/shared/tts-settings-caps"
import { castNameFromCellMetadata, copyCastsOntoSplitPieces, splitPieceBelongsTo, type SplitCastSource } from "../../../src/lib/audio/split-cast"
import { mediaDefaultsFromOrgSettings, type MediaDefaults } from "../../../db/shared/media-setting-defaults"

const projectSettings = new Hono<AuthHonoEnv>()

// Minimum role allowed to write settings — `maintainer` per the spec
// (project-configuration stories: name-and-configure-project,
// customize-ai-settings, monitor-project-health, validate-translation).
const SETTINGS_WRITE_MIN_ROLE = ROLE.MAINTAINER

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
 * it didn't touch — treating presence as a change would make every carve-out
 * below unreachable in practice, and would refuse every save on a project
 * that still carries the retired `terminology` blob (AQU-1724).
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
  orgValidationCount: number | null
  orgValidationCountAudio: number | null
  orgPolicy: ProjectOrgPolicy
  visibilityFloors: VisibilityFloorsView
  orgMediaDefaults: MediaDefaults
}> {
  const [orgCountStructuralCells, orgThresholds, policy, orgMediaDefaults] = await Promise.all([
    getOrgCountStructuralCellsForProject(env, projectId),
    // AQU-1771: the org's validation defaults, null when it set none. Read
    // here for the same reason as countStructuralCells: a project member who
    // is not in the org cannot read the org settings route.
    loadOrgValidationDefaults(env.AQUILLA_PG, projectId),
    // AQU-1771: and the rest of the org policy the project's own surfaces
    // need, for the same reason — plus the visibility floors this project
    // actually enforces, its own stricter values included.
    getProjectOrgPolicy(env, projectId, response.settings),
    // AQU-1768: and its media defaults, for the same reason.
    loadOrgMediaDefaults(env, projectId),
  ])
  const { visibility } = policy
  return {
    ...response,
    orgCountStructuralCells,
    orgValidationCount: orgThresholds.validationCount,
    orgValidationCountAudio: orgThresholds.validationCountAudio,
    orgPolicy: policy.orgPolicy,
    visibilityFloors: {
      rosterViewMinRole: {
        org: visibility.org.rosterViewMinRole,
        project: visibility.project.rosterViewMinRole,
        effective: visibility.rosterViewMinRole,
      },
      memberProgressViewMinRole: {
        org: visibility.org.memberProgressViewMinRole,
        project: visibility.project.memberProgressViewMinRole,
        effective: visibility.memberProgressViewMinRole,
      },
    },
    orgMediaDefaults,
  }
}

/**
 * AQU-1768: the media defaults the project's org set (valid values only;
 * empty when it set none or the project has no org). Best-effort: a failed
 * read reports none, so the page shows each control's built-in default rather
 * than failing the settings response.
 */
async function loadOrgMediaDefaults(
  env: AuthHonoEnv["Bindings"],
  projectId: string,
): Promise<MediaDefaults> {
  try {
    const row = await env.AQUILLA_PG.prepare(
      `SELECT os.settings
         FROM projects p
         JOIN org_settings os ON os.org_id = p.org_id
        WHERE p.id = ?`,
    ).bind(projectId).first<{ settings: string | null }>()
    return mediaDefaultsFromOrgSettings(row?.settings ? JSON.parse(row.settings) : null)
  } catch {
    return {}
  }
}

/**
 * AQU-1771: each visibility floor as the org sets it, as this project sets it
 * (null when the project follows the org, including a stored value that is
 * not stricter), and the floor the project enforces — the higher of the two.
 */
type VisibilityFloorsView = Record<VisibilityFloorKey, { org: number; project: number | null; effective: number }>

/**
 * AQU-1771: the rules for changing a project's own visibility floors. Judged
 * on the CHANGE, so a stored value rides along unchanged on an unrelated save.
 *
 *   - A value set must be a role-ladder level at or above the org's floor: a
 *     project can make who sees its member list or each member's progress
 *     stricter, never looser (400). A stored value the org has since
 *     overtaken is inert — the floor is the higher of the two.
 *   - Lowering or removing a stored value needs a role at least that value
 *     (Sam, 2026-10-13: "Owners only" binds maintainers — only an owner may
 *     loosen it). Removing the key by leaving it out of the whole-object write
 *     counts as removing it (403, the role-required shape). Raising stays open
 *     to anyone who may write the project's settings.
 */
async function visibilityFloorWriteRefusal(
  env: AuthHonoEnv["Bindings"],
  projectId: string,
  stored: Record<string, unknown>,
  next: Record<string, unknown>,
  role: { level: number; source?: string | null },
): Promise<{ status: 400 | 403; body: { error: string } | RoleRequiredBody } | null> {
  const changed = VISIBILITY_FLOOR_KEYS.filter(
    (key) => JSON.stringify(stored[key]) !== JSON.stringify(next[key]),
  )
  if (changed.length === 0) return null
  const { orgPolicy } = await getProjectOrgPolicy(env, projectId, next)
  for (const key of changed) {
    const what = key === "rosterViewMinRole" ? "the member list" : "each member's progress"
    if (next[key] != null) {
      const level = parseProjectVisibilityFloor(next[key])
      if (level == null) {
        return { status: 400, body: { error: `${key} must be a role level: one of ${VISIBILITY_FLOOR_LEVELS.join(", ")}` } }
      }
      const orgFloor = orgPolicy[key]
      if (level < orgFloor) {
        return {
          status: 400,
          body: {
            error: `${key} ${level} is below the organization's setting (${orgFloor}). A project can only make who sees ${what} stricter than its organization does: choose ${orgFloor} or higher, or remove ${key} to follow the organization.`,
          },
        }
      }
    }
    const storedLevel = parseProjectVisibilityFloor(stored[key])
    const nextLevel = parseProjectVisibilityFloor(next[key])
    const loosens = storedLevel != null && (nextLevel == null || nextLevel < storedLevel)
    if (loosens && role.level < storedLevel) {
      const name = (ROLE_NAMES[storedLevel] ?? `role ${storedLevel}`).replaceAll("_", " ")
      return {
        status: 403,
        body: roleRequiredBody(
          `${name} or higher is required to make who sees ${what} on this project less strict (${key} is ${storedLevel})`,
          storedLevel,
          role,
        ),
      }
    }
  }
  return null
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
  // This runs whenever the wall left the caller unrestricted, wall on or
  // off, so it stops at the wall's own floor. A project lead is below that
  // floor: a leftover lane scope still limits them.
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

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

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
    const incomingTts = plainRecord(settings.ttsSettings)
    if (role.level < SETTINGS_WRITE_MIN_ROLE) {
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
    }

    // The diff against the stored blob, for EVERY role, taken after the
    // read-wall echo is put back so a hidden-lane echo cannot fake a change.
    // The retired `terminology` key is refused whoever writes it (AQU-1724),
    // and the sub-maintainer carve-outs below are judged on the same diff.
    const changed = changedSettingsKeys(stored.settings, settings)
    if (changed.includes(RETIRED_TERMINOLOGY_KEY)) {
      return c.json({ error: RETIRED_TERMINOLOGY_MESSAGE }, 400)
    }

    if (
      role.level < SETTINGS_WRITE_MIN_ROLE
      && incomingTts
      && incomingRewritesHiddenVoices(
        plainRecord(stored.settings.ttsSettings) ?? {},
        incomingTts,
        visible,
        lanes,
      )
    ) {
      return c.json({ error: "voice changes are limited to lanes you can write" }, 403)
    }

    if (role.level < SETTINGS_WRITE_MIN_ROLE) {
      // AQU-1086 and the single-key scopes below: below the maintainer floor,
      // the ONLY writes allowed are a no-op one or one whose changed keys all
      // sit in one scope, gated by that scope's floor. Any other changed key
      // falls through to the maintainer 403 — lowering a floor must never
      // widen write access to AI config, health, validation, or anything else.
      // Each carve-out is key-exact and carries its own floor. A write that
      // touches anything else — even alongside a permitted key — falls through
      // to the maintainer 403, so widening one of these can never widen access
      // to AI config, health, languages, or the rest.
      const noop = changed.length === 0
      const autopilotOnly = changed.length > 0
        && changed.every((key) => key === AUTOPILOT_KEY)
      const countStructuralOnly = changed.length > 0
        && changed.every((key) => key === COUNT_STRUCTURAL_KEY)
      const alignmentSeedsOnly = changed.length > 0
        && changed.every((key) => key === ALIGNMENT_SEEDS_KEY)
      const storedTts = plainRecord(stored.settings.ttsSettings) ?? {}
      const nextTts = plainRecord(settings.ttsSettings) ?? {}
      const voiceLeadWrite = changed.length > 0
        && changed.every((key) => key === "ttsSettings")
        && stored.settings.projectLeadsManageVoices === true
        && role.level >= ROLE.PROJECT_LEAD
        && leadMaySaveTtsSettings(storedTts, nextTts, visible, lanes)
      if (
        !noop && !autopilotOnly
        && !countStructuralOnly && !alignmentSeedsOnly && !voiceLeadWrite
      ) {
        return c.json(
          { error: `role >= maintainer (${SETTINGS_WRITE_MIN_ROLE}) required` },
          403,
        )
      }
      if (noop) {
        // A write that changes nothing — a read-modify-write client echoes
        // every key it didn't touch. Before AQU-1724 it reached the
        // terminology-only branch (vacuously true for an empty diff) and was
        // admitted at the org's termbaseEditMinRole floor. It keeps exactly
        // that floor, so retiring the key changes no one's no-op save; routed
        // to the language scope instead it would need languageEditMinRole
        // (project lead by default since AQU-984, but an org may store
        // maintainer), and a lead's save would then 403.
        const noopFloor = await getTermbaseEditMinRoleForProject(c.env, projectId)
        if (role.level < noopFloor) {
          return c.json(
            { error: `role >= ${noopFloor} required to save project settings (org termbaseEditMinRole)` },
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
    const rawLeadVoices = (settings as Record<string, unknown>).projectLeadsManageVoices
    if (rawLeadVoices !== undefined && typeof rawLeadVoices !== "boolean") {
      return c.json({ error: "projectLeadsManageVoices must be a boolean" }, 400)
    }

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

    // AQU-1692: the voice index reads these corrections, so a malformed map is
    // refused the same way, and by the same rule as the Agent API. Null clears.
    // An unchanged stored value rides along, as for bibleEnrichments above.
    const rawVoiceOverrides = (body.settings as Record<string, unknown>).bibleVoiceOverrides
    if (rawVoiceOverrides !== undefined) {
      const problem = validateSettingsKeyValue("bibleVoiceOverrides", rawVoiceOverrides)
      if (problem) {
        const before = stored.settings.bibleVoiceOverrides
        if (JSON.stringify(before) !== JSON.stringify(rawVoiceOverrides)) {
          return c.json({ error: problem }, 400)
        }
      }
    }

    // AQU-1943: the ceiling on the TTS blob. Every member re-reads these
    // settings on workspace open and on window focus, so a runaway voice
    // library is not this project's problem alone — one production project
    // reached 5.45 MB (31,287 voices) and the Voices panel died on open. The
    // refusal is 422 rather than 400: the shape is legal, the size is not.
    //
    // Judged on the CHANGE, like bibleEnrichments and bibleVoiceOverrides
    // above: a project that is already over the cap must still be able to
    // save the rest of its settings while its blob rides along unchanged, and
    // must still be able to write the prune that brings it back under
    // (AQU-1941). What it cannot do is grow further.
    const rawTtsSettings = (settings as Record<string, unknown>).ttsSettings
    if (rawTtsSettings !== undefined) {
      const over = ttsSettingsCapProblem(rawTtsSettings)
      if (over && JSON.stringify(stored.settings.ttsSettings) !== JSON.stringify(rawTtsSettings)) {
        console.warn(
          `[project-settings] ttsSettings over cap for ${projectId}: `
          + `${over.size.voices} voices, ${over.size.assignments} assignments, ${over.size.bytes} bytes`,
        )
        return c.json({ error: over.message }, 422)
      }
    }

    // AQU-1771: a project's own visibility floors can only be stricter.
    const floorRefusal = await visibilityFloorWriteRefusal(c.env, projectId, stored.settings, settings, role)
    if (floorRefusal) return c.json(floorRefusal.body, floorRefusal.status)

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
    // AQU-1771: a change to what a linked Monday board shows marked its link
    // dirty in the write above; push it now rather than at the next cron.
    pushDirtyLinksAfterResponse(c, {
      projectIds: [projectId, ...(result.propagated ?? []).map((copy) => copy.projectId)],
    })
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
  /**
   * Media redesign slice 1: what the new language delivers. The create dialog
   * sends each language's choice; absent (every other caller) is Text.
   */
  delivers: z.enum(LANE_DELIVERS).optional(),
})

const archiveLaneSchema = z.object({
  archived: z.boolean(),
})

const laneRecordsAudioSchema = z.object({
  recordsAudio: z.boolean(),
})

const laneDeliversSchema = z.object({
  delivers: z.enum(LANE_DELIVERS),
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

// AQU-1770: a language added, renamed or archived changes what a linked Monday
// board shows — its Languages column, and which languages its percentages
// cover — with no project edit to trigger a push. Mark the project's boards
// dirty and push after the response, as a counting-settings change does; the
// cron flush picks up anything this misses.
async function pushMondayAfterLaneChange(
  c: { env: AuthHonoEnv["Bindings"]; executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  projectId: string,
): Promise<void> {
  await markProjectSyncLinksDirty(c.env.AQUILLA_PG, [projectId])
  pushDirtyLinksAfterResponse(c, { projectIds: [projectId] })
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
        ...(body.delivers ? { delivers: body.delivers } : {}),
        targetLanguage,
        existing: (current.lanes ?? []).map((lane) => ({
          id: lane.id,
          name: lane.name,
          language: lane.language,
          legacyTag: lane.legacyTag,
        })),
      })
    } catch (e) {
      // [Pen test] never echo driver text (can name tables/columns) to the client.
      console.error("[project-settings] write failed:", e)
      return c.json({ error: "write failed" }, 500)
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
      await grantCreatedLaneToActor(c.env.AQUILLA_PG, projectId, created.laneId, user.id)
    } catch (e) {
      // [Pen test] never echo driver text (can name tables/columns) to the client.
      console.error("[project-settings] write failed:", e)
      return c.json({ error: "write failed" }, 500)
    }
    // AQU-1594: the lane row is the registry. Do not mirror the tag into
    // settings.targetLanes.
    const fresh = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
    notifySettingsChangedBestEffort(c, projectId, fresh.version)
    const lane = fresh.lanes?.find((row) => row.id === created.laneId) ?? null
    await pushMondayAfterLaneChange(c, projectId)
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
    await pushMondayAfterLaneChange(c, projectId)
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
    // [Pen test] never echo driver text (can name tables/columns) to the client.
    console.error("[project-settings] read failed:", e)
    return c.json({ error: "read failed" }, 500)
  }
})

// AQU-1954: "Records audio" on one language row. Off (the default), a file
// counts this language's audio only once it has a recording in it; on, every
// file owes it — the plan board, the Progress card and the org's numbers all
// follow. Gated like every other change to the Languages card.
projectSettings.post(
  "/:projectId/lanes/:laneId/records-audio",
  authMiddleware,
  zValidator("json", laneRecordsAudioSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const laneId = c.req.param("laneId") as string
    const denied = await denyLanguageWrite(c.env, user, projectId)
    if (denied) return c.json(denied, 403)
    const result = await setTargetLaneRecordsAudio(
      c.env.AQUILLA_PG,
      projectId,
      laneId,
      c.req.valid("json").recordsAudio,
    )
    if (result.status === "not_found") return c.json({ error: "lane not found" }, 404)
    const fresh = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
    notifySettingsChangedBestEffort(c, projectId, fresh.version)
    return c.json({ lane: fresh.lanes?.find((row) => row.id === laneId) ?? result.lane })
  },
)

// Media redesign slice 1: the "Delivers" choice on one language row — Text,
// Audio, or Text and audio — which replaced "Records audio" above. It decides
// how that language's lines are counted everywhere (src/lib/lanes/
// lane-delivers.ts), so the dashboard, the plan board and a linked Monday or
// Airtable board all move with it: the boards are pushed like any other lane
// change. Gated like every other change to the Languages card. Nothing is
// deleted; switching back restores every number.
projectSettings.post(
  "/:projectId/lanes/:laneId/delivers",
  authMiddleware,
  zValidator("json", laneDeliversSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const laneId = c.req.param("laneId") as string
    const denied = await denyLanguageWrite(c.env, user, projectId)
    if (denied) return c.json(denied, 403)
    const result = await setTargetLaneDelivers(
      c.env.AQUILLA_PG,
      projectId,
      laneId,
      c.req.valid("json").delivers,
    )
    if (result.status === "not_found") return c.json({ error: "lane not found" }, 404)
    const fresh = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
    notifySettingsChangedBestEffort(c, projectId, fresh.version)
    await pushMondayAfterLaneChange(c, projectId)
    return c.json({ lane: fresh.lanes?.find((row) => row.id === laneId) ?? result.lane })
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
    // AQU-1600: the former default lane archives like any other lane. The only
    // refusal left is the last active one — a project must keep at least one
    // non-archived target lane.
    if (result.status === "last_lane") return c.json({ error: "last_lane" }, 400)
    // AQU-2223: `lanes.archived_at` is the only record. The retired
    // `settings.archivedLanes` mirror is no longer written.
    const fresh = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
    const notifyPromise = notifySyncWorkerOfProjectSettingsChange(c.env, projectId, fresh.version)
    try {
      c.executionCtx.waitUntil(notifyPromise)
    } catch {
      void notifyPromise
    }
    await pushMondayAfterLaneChange(c, projectId)
    return c.json({ lane: fresh.lanes?.find((row) => row.id === laneId) ?? result.lane })
  },
)

const splitCastSchema = z.object({
  fileId: z.string().min(1).max(200),
  splits: z.array(z.object({
    cellId: z.string().min(1).max(200),
    sameKindAsFirst: z.array(z.string().min(1).max(200)).max(40),
  })).min(1).max(400),
})

/**
 * Every new piece must be a source row in this file that was split off the
 * named row. One stranger refuses the whole request, so an extra id cannot
 * ride along with a real split. An empty piece list has nothing to prove.
 * The character name is read off the original row, never off the request, so
 * the copy can follow a character's voice without the caller naming one.
 */
async function splitsReadyToCopy(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  splits: readonly { cellId: string; sameKindAsFirst: readonly string[] }[],
): Promise<SplitCastSource[] | null> {
  const parentOf = new Map<string, string>()
  for (const split of splits) {
    for (const pieceId of split.sameKindAsFirst) {
      const parent = parentOf.get(pieceId)
      if (parent !== undefined && parent !== split.cellId) return null
      parentOf.set(pieceId, split.cellId)
    }
  }
  const wanted = new Set<string>([...parentOf.keys(), ...splits.map((split) => split.cellId)])
  const found = new Map<string, unknown>()
  if (wanted.size > 0) {
    const ids = [...wanted]
    const marks = ids.map(() => "?").join(", ")
    const rows = await db
      .prepare(
        `SELECT cell_id, metadata FROM cells
          WHERE project_id = ? AND file_id = ? AND side = 'source' AND cell_id IN (${marks})`,
      )
      .bind(projectId, fileId, ...ids)
      .all<{ cell_id: string; metadata: unknown }>()
    for (const row of rows.results ?? []) found.set(row.cell_id, row.metadata)
  }
  for (const [pieceId, parentId] of parentOf) {
    if (!splitPieceBelongsTo(found.get(pieceId), parentId)) return null
  }
  return splits.map((split) => {
    const castName = castNameFromCellMetadata(found.get(split.cellId))
    return castName
      ? { cellId: split.cellId, sameKindAsFirst: split.sameKindAsFirst, castName }
      : { cellId: split.cellId, sameKindAsFirst: split.sameKindAsFirst }
  })
}

// AQU-2101: a quote split is a source edit, which a project lead may do, and
// it has to copy each lane's cast onto the new narration pieces. That copy
// is not a voice-panel edit: it must land on lanes the lead cannot see, and
// it must land even when "project leads can manage voices" is off. The only
// mutation is filling absent cell ids with a voice the same map already holds,
// and only onto pieces this file records as split from that row.
projectSettings.post(
  "/:projectId/split-casts",
  authMiddleware,
  zValidator("json", splitCastSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const role = await resolveProjectRole(c.env, user, projectId)
    if (!role) return c.json({ error: "no access to project" }, 403)
    if (role.level < ROLE.PROJECT_LEAD) {
      return c.json({ error: "role >= project lead required" }, 403)
    }
    const { fileId, splits } = c.req.valid("json")
    const ready = await splitsReadyToCopy(c.env.AQUILLA_PG, projectId, fileId, splits)
    if (!ready) return c.json({ error: "not a split piece" }, 422)
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
      const storedTts = plainRecord(current.settings.ttsSettings) ?? {}
      const nextTts = copyCastsOntoSplitPieces(storedTts, ready)
      if (!nextTts) return c.json({ changed: false })
      const over = ttsSettingsCapProblem(nextTts)
      if (over) return c.json({ error: over.message }, 422)
      const result = await updateProjectSettingsShared(c.env.AQUILLA_PG, {
        projectId,
        settings: { ...current.settings, ttsSettings: nextTts },
        ifMatchVersion: current.version,
        updatedBy: user.id,
        blobs: c.env.SNAPSHOTS ?? null,
        r2KeyPrefix: c.env.R2_KEY_PREFIX,
      })
      if (result.status === "conflict") continue
      if (result.status === "error") return c.json({ error: "write failed" }, 500)
      const notifyPromise = notifySyncWorkerOfProjectSettingsChange(
        c.env,
        projectId,
        result.settings.version,
      )
      try {
        c.executionCtx.waitUntil(notifyPromise)
      } catch {
        void notifyPromise
      }
      return c.json({ changed: true })
    }
    return c.json({ error: "version mismatch" }, 409)
  },
)

export default projectSettings
