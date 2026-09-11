import { FRONTIER_API_URL } from "./sync-token"
import { t } from "@/lib/i18n/standalone"
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
   * AQU-646: may people add new lines into the silences on the timeline?
   *
   * OFF unless explicitly turned on. The affordance was built speculatively —
   * no client has asked for it — and it is underdeveloped enough to be a
   * liability: its mic over an empty stretch used to mint a subtitle line and
   * record against it, producing a take matching no audio cue at all. Removal
   * of an empty added line is deliberately NOT gated on this, so switching it
   * off can never strand a line somebody already made.
   */
  allowLineCreation?: boolean
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
   * NOTE THE DIVERGENCE FROM `allowLineCreation` ABOVE, which is deliberate and
   * not an oversight: that one leaves REMOVAL ungated so switching it off
   * cannot strand a line somebody made. Here, switching off does strand — three
   * user-added tracks become un-deletable and un-recolourable until it goes
   * back on. That is Sam's call (2026-08-22) and it is the coherent one for a
   * structural switch: the tracks keep working and keep playing, they simply
   * stop being editable, which is exactly what "turn track editing off" should
   * mean. Do not "restore consistency" with the sibling above.
   */
  allowTrackEditing?: boolean
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
