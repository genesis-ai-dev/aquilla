import { FRONTIER_API_URL } from "./sync-token"
import type {
  TranslationRule,
  RulePenalties,
  ProjectTtsSettings,
  AlgorithmicCheckOverride,
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
   * AQU-186: minimum role level required to trigger a harmonization sweep on
   * this project. Default (absent) = project_lead (500). Configurable up to
   * maintainer (600); lowering below project_lead is not allowed (hard floor).
   */
  harmonize_min_role?: "project_lead" | "maintainer"
  /** Synced voice profiles (voice library, cast, default voice, engine). The
   *  Gemini apiKey is deliberately omitted — it stays device-local. */
  ttsSettings?: Omit<ProjectTtsSettings, "apiKey">
  /** Project terminology / glossary concepts. Synced to D1 via the same
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
   * DCS (Door43) external-upstream cursor (spec §8). Present when this project is
   * a DCS-linked source/"adapter" project — pins it to a Door43 release so the
   * freshness/delta engine can ask "am I out of date?". Written by the Door43
   * importer; replacing this key replaces the whole cursor object.
   * See docs/superpowers/specs/2026-07-06-dcs-importer-design.md §8.
   */
  dcsUpstream?: import("@/lib/dcs/types").DcsCursor
  /**
   * AQU-538: non-default target-language lanes ('' is always implicit, never stored).
   * Opaque BCP-47-ish tags; order = display order.
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
 * GET /api/v2/projects/:id/settings.
 *
 * Returns null on 403/404 (caller has no access or project doesn't exist
 * server-side) and on any network error — callers fall back to local IDB.
 * Real server failures (5xx that aren't network errors) also return null;
 * we do not surface them as exceptions because the consumer's UI is
 * already tolerant of "offline / unknown".
 */
export async function fetchProjectSettings(
  jwt: string,
  projectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<ProjectSettingsResponse | null> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
      { headers: authHeaders(jwt) },
    )
    if (!res.ok) return null
    return (await res.json()) as ProjectSettingsResponse
  } catch {
    return null
  }
}

/**
 * PATCH /api/v2/projects/:id/settings. The server merges top-level keys.
 * Caller must include `ifMatchVersion`; mismatched version returns
 * `{kind: "conflict", latest}`. Sub-PROJECT_LEAD callers get
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
    return { kind: "error", status: res.status, message: "version conflict" }
  }
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { required?: number; role?: number }
    return { kind: "forbidden", required: body.required ?? 500, role: body.role ?? 0 }
  }
  const text = await res.text().catch(() => "")
  return { kind: "error", status: res.status, message: text }
}
