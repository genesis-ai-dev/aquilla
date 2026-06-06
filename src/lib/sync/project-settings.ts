import { FRONTIER_API_URL } from "./sync-token"
import type {
  TranslationRule,
  RulePenalties,
  ProjectTtsSettings,
} from "@/lib/parsers/types"
import type { Concept } from "@/lib/terminology/types"

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
  validationCount?: number
  validationCountAudio?: number
  validationRoleFloor?: "reviewer" | "project_lead" | "maintainer"
  validationNamedUsers?: string[]
  allowSelfValidation?: boolean
  /** Synced voice profiles (voice library, cast, default voice, engine). The
   *  Gemini apiKey is deliberately omitted — it stays device-local. */
  ttsSettings?: Omit<ProjectTtsSettings, "apiKey">
  /** Project terminology / glossary concepts. Synced to D1 via the same
   *  top-level key mechanism as `rules`. Absent → no terminology enforcement. */
  terminology?: Concept[]
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
