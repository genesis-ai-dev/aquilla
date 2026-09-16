import { FRONTIER_API_URL } from "./sync-token"
import { t } from "@/lib/i18n/standalone"
import { ROLE, type RoleLevel } from "@/lib/frontier/roles"
import type {
  TranslationRule,
  RulePenalties,
  ProjectTtsSettings,
  AlgorithmicCheckOverride,
  AudioTimingMode,
  BuiltinCheckId,
} from "@/lib/parsers/types"
import type { Concept } from "@/lib/terminology/types"
import type { LivingMemoryEntry } from "@/lib/parsers/types"
import type { TranslationBrief } from "@/lib/brief/types"
import type { DraftContextSettings } from "@/lib/completion/draft-context"

/** Initial server version for projects with no settings row. */
export const PROJECT_SETTINGS_VERSION_INITIAL = 0

/**
 * AQU-1068: the stored `cellEditingFloor` vocabulary — "none" plus the rungs of
 * the standard role ladder this floor may be set to.
 *
 * Exported because ProjectSettings.tsx used to repeat the union literally in
 * two annotations, and a widening that reached only one of them would compile
 * in a rung the control could never actually hold. `ProjectRecord` still
 * spells it out (a type cycle for one alias is a poor trade) but cannot drift
 * narrower: `useProject`'s `assign()` copies this field into it.
 *
 * Deliberately NOT sourced from `db/shared/cell-editing-floor.ts`: the client
 * cannot import server code, which is why this file carries a copy of the
 * mapping at all — see that module's header.
 */
export type CellEditingTier =
  | "none"
  | "commenter"
  | "reviewer"
  | "contributor"
  | "project_lead"
  | "maintainer"

/**
 * The synced subset of project-wide fields. Mirrors the server's settings
 * JSON. Top-level keys only — replacing `rules` replaces the whole array.
 *
 * Device-local fields (apiKey, endpoint, audio strategy, experimental flags,
 * TTS, dismissed-banner state) are deliberately absent.
 */
export interface ProjectWideSettings {
  sourceLanguage?: string
  targetLanguage?: string
  systemPrompt?: string
  rules?: TranslationRule[]
  rulePenalties?: RulePenalties
  /** Built-in check overrides (enable/severity). Synced like `rules` —
   *  replacing this key replaces the whole map, so writers must send the
   *  full merged object. Project-wide so LQA severity is consistent across
   *  devices/members (same rationale as `rulePenalties`). */
  algorithmicChecks?: Partial<Record<BuiltinCheckId, AlgorithmicCheckOverride>>
  validationCount?: number
  validationCountAudio?: number
  validationRoleFloor?: "reviewer" | "project_lead" | "maintainer"
  validationNamedUsers?: string[]
  allowSelfValidation?: boolean
  /**
   * AQU-1068: who may add and remove cells in this project's files?
   *
   * Supersedes AQU-646's `allowLineCreation` boolean, which asked the same
   * question of one surface (the timeline's silences) and could only answer
   * yes-or-no. Cell editing is now a project-wide capability with a role
   * FLOOR, named with the product's standard permission ladder so a project
   * admin picks the same words here they picked on the Members panel:
   * "maintainer" admits 600 and up, "project_lead" 500, "contributor" 400,
   * "reviewer" 300, "commenter" 200.
   *
   * "none" — the default, and what an absent key means — admits NOBODY, and
   * that includes an owner. This is a "whether", not a "who": a project that
   * has not opted in does not restructure its files at all, so there is no
   * clearance that skips the question. Off by default because the affordance
   * is the liability the setting exists to contain — removing a cell takes its
   * translations, takes, comments and validations with it (see the cascade in
   * event-projection's `source.cell.delete` case).
   *
   * IT IS A PRODUCT RULE, ENFORCED AT THE AFFORDANCE, AND THAT IS DELIBERATE
   * (Sam, 2026-09-09). This value decides which buttons exist — the row menu,
   * the timeline's add and remove, the gap inserts, and the agent's proposal
   * staging in auth-worker, which reads the same shared mapping. The sync
   * perimeter does NOT check it. It was checked there until 2026-09-09, and
   * doing so silently refused three flows that emit the same event kinds
   * through the user's own outbox: audio-cue re-import, DCS upstream import
   * and repair, and diarization. The setting stops accidents, not attackers,
   * and everyone who can reach the perimeter is already a member the org
   * admitted. Contrast `allowTrackEditing` below, which stays server-enforced.
   *
   * REMOVING AN IMPORTED CELL NEEDS MAINTAINER, WHATEVER THE TIER, and that
   * half IS enforced at the perimeter (authorize.ts) because it protects the
   * client's own file rather than merely shaping the UI. Below that rank a
   * person only ever removes a line somebody added by hand here.
   *
   * The old boolean is deliberately NOT migrated: a project that had it on
   * lands on "none" like everyone else, and a maintainer picks a tier when
   * they want the affordance back (Sam, 2026-08-29).
   */
  cellEditingFloor?: CellEditingTier
  /**
   * AQU-646 stage 2: may this project's timelines be RESTRUCTURED — tracks
   * added and deleted, grouped into folders, recoloured?
   *
   * OFF unless explicitly turned on, and it is a SECOND gate rather than a
   * floor change: `file.track.set` is already maintainer-floored, so this
   * answers *whether*, not *who*, and with it off the write is refused even to
   * an owner. Multi-track is capability for clients who want it; a project that
   * never turns it on should not be able to tell it was built.
   *
   * RENAME AND DRAG-TO-REORDER ARE DELIBERATELY NOT GATED ON THIS. Both already
   * ship, and a new setting defaulting to off must not silently take an
   * existing capability away from every project that has one. They stay
   * maintainer-only, which is what they were.
   *
   * NOTE HOW THIS DIFFERS FROM `cellEditingFloor` ABOVE. Two differences now.
   * Shape: that one names a role FLOOR as well as answering whether, while
   * this is a bare whether riding `file.track.set`'s existing MAINTAINER
   * floor. And enforcement: THIS ONE IS CHECKED ON THE SERVER and that one is
   * not, because no import or re-import path emits `file.track.set`, so
   * enforcing it at the perimeter breaks nothing. On stranding they AGREE,
   * because both govern removal as well as insertion. Switching
   * this off strands — three user-added tracks become un-deletable and
   * un-recolourable until it goes back on. That is Sam's call (2026-08-22) and
   * it is the coherent one for a structural switch: the tracks keep working and
   * keep playing, they simply stop being editable, which is exactly what "turn
   * track editing off" should mean.
   */
  allowTrackEditing?: boolean
  /**
   * AQU-1246: does this project get the experimental Autopilot surface at all?
   *
   * OFF unless an owner or lead explicitly turns it on, and OFF means the
   * surfaces are ABSENT — no pill, no overview panel, no settings entry —
   * rather than present-and-disabled. Autopilot is an experiment; before this
   * key the only gate was a device-local switch every member could flip in one
   * click, so the feature was effectively on-by-one-click for every project in
   * production (Joel, 2026-09-10).
   *
   * This is the ONE key below the maintainer settings floor: a patch that
   * changes only this is admitted at project_lead(500)+, mirroring the
   * `terminology` carve-out. That is deliberate — deciding whether your own
   * project may try an experiment is a lead's call, and it hands them nothing
   * else (AI config, languages, health thresholds all stay maintainer-gated).
   * The server re-derives the same "only this key changed" test and is
   * authoritative (auth-worker/src/routes/project-settings.ts).
   *
   * Turning it back OFF hides the surfaces but does not stop a run — the
   * auth-worker cron owns run lifecycle, and stopping work is what Stop is
   * for. Projects already using Autopilot via the legacy device-local flag
   * keep it; see `isAutopilotVisible` in src/lib/features/flags.ts.
   */
  autopilotEnabled?: boolean
  /**
   * AQU-186: minimum role level required to trigger a harmonization sweep on
   * this project. Default (absent) = project_lead (500). Configurable up to
   * maintainer (600); lowering below project_lead is not allowed (hard floor).
   */
  harmonize_min_role?: "project_lead" | "maintainer"
  /** Synced voice profiles (voice library, cast, default voice, engine). The
   *  Gemini apiKey is deliberately omitted — it stays device-local. */
  ttsSettings?: Omit<ProjectTtsSettings, "apiKey">
  /** Project terminology / glossary concepts. Synced to Postgres via the same
   *  top-level key mechanism as `rules`. Absent → no terminology enforcement. */
  terminology?: Concept[]
  /** Authored living-memory guidance entries (instructions + standards). */
  livingMemoryEntries?: LivingMemoryEntry[]
  /** The project's skopos/Paratext translation brief. Synced like
   *  `livingMemoryEntries` — replacing this key replaces the whole object.
   *  Absent → no brief authored yet. See
   *  docs/superpowers/specs/2026-06-17-translation-brief-design.md. */
  translationBrief?: TranslationBrief
  /**
   * AI-draft context budget (Phase 0). Currently just how many preceding
   * committed-target cells to feed the draft as discourse left-context. Synced
   * like other top-level keys; absent → DEFAULT_DRAFT_CONTEXT applies.
   * See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D10).
   */
  draftContext?: DraftContextSettings
  /**
   * Persisted interlinear alignment seeds (AQU-207). Each entry is a
   * (srcToken, tgtToken, weight) triple; positive weight = confirmed,
   * negative = invalidated. Synced additively the same way as `terminology`.
   */
  alignmentSeeds?: import("@/lib/completion/interlinear").AlignmentSeed[]
  /**
   * Bible Aquifer reference data (bibletranslation.org). AQU-460 derive-on-read:
   * this is the EXPLICIT user override only. When absent, the effective value
   * is derived — on for scripture projects, off otherwise — and is NEVER
   * persisted just by viewing/loading a project. An explicit `true`/`false`
   * here always wins. Read server-side by the agent and the aquifer routes via
   * auth-worker/src/lib/aquifer/gate.ts (mirrors the same derivation).
   * See docs/superpowers/specs/2026-06-13-aquifer-integration-design.md.
   */
  bibleResourcesEnabled?: boolean
  /**
   * Knowledge base drafting toggle (spec docs/superpowers/specs/2026-08-07-knowledge-base-design.md).
   * When true, translation generation + predictions inject KB string-search
   * snippets into draft prompts. Agent access to the KB is NOT gated by this.
   * Default false. Read server-side by the draft tool via
   * auth-worker/src/lib/knowledge/gate.ts.
   */
  knowledgeBaseEnabled?: boolean
  /**
   * DCS (Door43) external-upstream cursor (spec §8). Present when this project is
   * a DCS-linked source/"adapter" project — pins it to a Door43 release so the
   * freshness/delta engine can ask "am I out of date?". Written by the Door43
   * importer; replacing this key replaces the whole cursor object.
   * See docs/superpowers/specs/2026-07-06-dcs-importer-design.md §8.
   */
  dcsUpstream?: import("@/lib/dcs/types").DcsCursor
  /**
   * Complete target-language lane registry, including the project's primary
   * lane (the same tag as `targetLanguage`). There is no implicit '' default
   * lane — every lane is an explicit entry. Opaque BCP-47-ish tags; order =
   * display order (primary first).
   */
  targetLanes?: string[]
  /**
   * AQU-601: archived lanes — a subset of `targetLanes` tags. Archived lanes
   * stay registered (their cell data and deep links keep working) but are
   * hidden by default in the workspace lane switcher and the settings manager.
   * Archiving never removes a lane from `targetLanes`; restoring just drops the
   * tag from here. Case-insensitive to match the lane-registry dedupe rule.
   */
  archivedLanes?: string[]
  /**
   * AQU-634: per-project opt-out for USFM front matter. When true, a USFM import
   * (primary upload, Paratext project, DCS/Door43 resource, and target-language
   * matching) EXCLUDES book-name/running-header/TOC, main title, and the whole
   * introduction block — restoring the AQU-585 filtering for Biblica-style
   * projects. Absent/false (the default) imports front matter as translatable
   * cells. In-body section headings and Psalm titles import in both modes.
   */
  importExcludeFrontMatter?: boolean
  /** AQU-646 SUB-53: dubbing (the default, and the meaning of absent) or
   *  audio-first. See the AudioTimingMode doc comment in parsers/types.ts. */
  audioTimingMode?: AudioTimingMode
  /**
   * AQU-646: may anyone below maintainer move a chip on the timeline?
   *
   * Sam, 2026-08-20: "It needs to be a very active decision to go mess around
   * with subtitle VTT timings." The imported timings are the client's own work
   * and the one thing in the project that nobody here should be adjusting by
   * accident — a stray drag silently moves a line for everybody, and there is
   * no second copy to compare against.
   *
   * Deliberately NOT scoped to project lead: Sam asked for leads to be locked
   * too, on the grounds that they can mess it up just as unintentionally. Only
   * a maintainer can unlock, which this needs no code to arrange — the settings
   * route already refuses every write below maintainer.
   */
  timingLocked?: boolean
  /**
   * AQU-1180: drop author fields from every agent-facing read. `'none'` means
   * `lastEditor`/`author` are ABSENT from the payload (not blanked), even for
   * a credential minted with `pii`. Absent/any other value is the default
   * (pseudonymous ids). Not agent-writable (`POLICY_SETTINGS_KEYS`).
   */
  agentAuthorship?: "none"
}

/** Absent means dubbing — the behaviour every project had before SUB-53. */
export function resolveAudioTimingMode(
  settings: Pick<ProjectWideSettings, "audioTimingMode"> | null | undefined,
): AudioTimingMode {
  return settings?.audioTimingMode === "audioFirst" ? "audioFirst" : "dubbing"
}

/**
 * ABSENT MEANS LOCKED — the opposite of the "absent = the behaviour we had
 * before" rule every other setting in this file follows, and deliberately so.
 *
 * A lock that has to be switched on protects nothing until somebody remembers
 * to switch it on, which for a safeguard against ACCIDENTS is the wrong way
 * round. So the only value that unlocks is an explicit `false`, and anything
 * else — missing, malformed, a stale client's `undefined` — locks.
 *
 * The consequence is worth naming: every project that exists locks the moment
 * this ships, and nobody below maintainer can move a chip until someone
 * unlocks it. That is what Sam asked for ("default to locked for everyone").
 */
export function resolveTimingLocked(
  settings: Pick<ProjectWideSettings, "timingLocked"> | null | undefined,
): boolean {
  return settings?.timingLocked !== false
}

/**
 * The role level `cellEditingFloor` admits, or `null` for "nobody".
 *
 * `null` is the answer for "none", for an absent key, and for any value this
 * build does not recognise — a tier a newer client invents must not read as
 * permission on an older one.
 *
 * THIS IS THE DECISION, not a mirror of one. Since 2026-09-09 the sync worker
 * does not check the tier at all (see its authorize.ts for why), so the
 * affordances gated on this function are what the setting means. The other
 * reader is auth-worker's agent staging, through the shared mapping in
 * `db/shared/cell-editing-floor.ts` — an apply button is a button too. Keep
 * this function and that one in lock-step.
 */
export function resolveCellEditingFloor(
  settings: Pick<ProjectWideSettings, "cellEditingFloor"> | null | undefined,
): RoleLevel | null {
  switch (settings?.cellEditingFloor) {
    case "maintainer":
      return ROLE.MAINTAINER
    case "project_lead":
      return ROLE.PROJECT_LEAD
    case "contributor":
      return ROLE.CONTRIBUTOR
    case "reviewer":
      return ROLE.REVIEWER
    case "commenter":
      return ROLE.COMMENTER
    default:
      return null
  }
}

export interface ProjectSettingsResponse {
  version: number
  updatedAt: string
  updatedBy: { id: number; username: string } | null
  settings: ProjectWideSettings
}

export type PatchResult =
  | { kind: "ok"; value: ProjectSettingsResponse }
  | { kind: "conflict"; latest: ProjectSettingsResponse }
  | { kind: "forbidden"; required: number; role: number }
  | { kind: "error"; status: number; message: string }

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  }
}

/**
 * Discriminated GET outcome so callers can tell "the server answered and
 * there are no settings for you" apart from "the request failed".
 *
 * - `{ok:true, value}`      — 200; the parsed settings row.
 * - `{ok:true, value:null}` — 403/404; the server ANSWERED: no settings exist
 *   for this caller (no access / project unknown). Definitive — treat as
 *   fetched.
 * - `{ok:false}`            — transport failure, 401 (expired token), or 5xx.
 *   The settings state is UNKNOWN; callers gating a destructive-if-wrong
 *   affordance (the DCS source lockdown) must stay fail-closed and retry
 *   later rather than treating this as "no settings".
 */
export type FetchProjectSettingsResult =
  | { ok: true; value: ProjectSettingsResponse | null }
  | { ok: false; status: number; message: string }

/** GET /api/v2/projects/:id/settings with a fail-closed-capable outcome. */
export async function fetchProjectSettingsResult(
  jwt: string,
  projectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<FetchProjectSettingsResult> {
  let res: Response
  try {
    res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
      { headers: authHeaders(jwt) },
    )
  } catch (e) {
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) }
  }
  if (res.ok) {
    try {
      return { ok: true, value: (await res.json()) as ProjectSettingsResponse }
    } catch (e) {
      return { ok: false, status: res.status, message: e instanceof Error ? e.message : String(e) }
    }
  }
  // 403/404: definitive "no settings for this caller" — the server answered.
  if (res.status === 403 || res.status === 404) return { ok: true, value: null }
  const text = await res.text().catch(() => "")
  return { ok: false, status: res.status, message: text }
}

/**
 * GET /api/v2/projects/:id/settings — legacy null-collapsing shape.
 *
 * Returns null on 403/404 (caller has no access or project doesn't exist
 * server-side) and on any transport/server failure — callers fall back to
 * local IDB. Consumers that must distinguish "no settings" from "request
 * failed" (fail-closed gates like the DCS source lockdown) must use
 * `fetchProjectSettingsResult` instead.
 */
export async function fetchProjectSettings(
  jwt: string,
  projectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<ProjectSettingsResponse | null> {
  const out = await fetchProjectSettingsResult(jwt, projectId, apiUrl)
  return out.ok ? out.value : null
}

/**
 * PATCH /api/v2/projects/:id/settings. The HTTP handler replaces the entire
 * settings blob (no per-key merge) — send a complete blob. Per-key merge is
 * only available via the `useProjectSettings` hook and the Agent API
 * PatchSettings command. Caller must include `ifMatchVersion`; mismatched
 * version returns `{kind: "conflict", latest}`. Sub-PROJECT_LEAD callers get
 * `{kind: "forbidden", required, role}`.
 */
export async function patchProjectSettings(
  jwt: string,
  projectId: string,
  settings: ProjectWideSettings,
  ifMatchVersion: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<PatchResult> {
  let res: Response
  try {
    res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
      {
        method: "PATCH",
        headers: authHeaders(jwt),
        body: JSON.stringify({ settings, ifMatchVersion }),
      },
    )
  } catch (e) {
    return { kind: "error", status: 0, message: e instanceof Error ? e.message : String(e) }
  }

  if (res.ok) {
    const value = (await res.json()) as ProjectSettingsResponse
    return { kind: "ok", value }
  }
  if (res.status === 409) {
    const body = (await res.json()) as {
      latest?: ProjectSettingsResponse
      current?: ProjectSettingsResponse
    }
    const latest = body.latest ?? body.current
    if (latest) return { kind: "conflict", latest }
    return { kind: "error", status: res.status, message: t("org.sync.versionConflictError") }
  }
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { required?: number; role?: number }
    return { kind: "forbidden", required: body.required ?? 500, role: body.role ?? 0 }
  }
  const text = await res.text().catch(() => "")
  return { kind: "error", status: res.status, message: text }
}
