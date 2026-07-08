import { FRONTIER_API_URL } from "./sync-token"
import type { TranslationRule, PromotionRequest } from "@/lib/parsers/types"

/**
 * Provider-keyed map of org-scoped API keys. Keys are provider identifiers
 * (e.g. "gemini-tts") and values are the raw API key strings. These are set
 * once by an org owner/maintainer and apply as the baseline for all members
 * and projects in the org. Precedence at resolution time:
 *   project key > user (browser-local) key > org key
 *
 * FRO-433: extend to new providers by adding more entries here.
 */
export interface OrgProviderKeys {
  "gemini-tts"?: string
  [provider: string]: string | undefined
}

/**
 * The synced subset of org-wide settings. Shape is intentionally open (server
 * is a dumb store) but we type the known keys.
 */
export interface OrgWideSettings {
  rules?: TranslationRule[]
  promotionRequests?: PromotionRequest[]
  /**
   * FRO-253: Minimum role level required to export project deliverables.
   * Default (when absent) = MAINTAINER (600) per spec Q32. Org owners can
   * lower it (e.g., CONTRIBUTOR = 400) or raise it (e.g., OWNER = 700).
   * Matched against the sync-token role on every export/download request.
   */
  exportMinRole?: number
  /**
   * AQU-485: Minimum role level required to see the member roster (list +
   * count) on org and project surfaces. Default (when absent) = MAINTAINER
   * (600) — safe for sensitive teams that don't want to reveal who/how many
   * are on a project, even to their own members. Independent of
   * memberProgressViewMinRole: a team can show the roster while hiding
   * per-member progress, or vice versa.
   */
  rosterViewMinRole?: number
  /**
   * AQU-485: Minimum role level required to see per-member progress /
   * productivity. Default (when absent) = MAINTAINER (600). Separate from
   * rosterViewMinRole — being allowed to see WHO is on the team does not
   * imply being allowed to see WHAT each person did.
   *
   * AQU-498: consumed by ProjectOverview's Team card + the sync-worker's
   * member-activity-read-route (server-side floor via resolveMemberProgressFloor).
   */
  memberProgressViewMinRole?: number
  /**
   * FRO-433: Org-scoped provider API keys. Set once by an org owner/maintainer;
   * used as the baseline for all members and projects in the org.
   * Precedence: project key > user (localStorage) key > org key.
   */
  orgProviderKeys?: OrgProviderKeys
}

export interface OrgSettingsResponse {
  orgId: number
  settings: OrgWideSettings
  version: number
  updatedAt: string | null
  updatedBy: number | null
}

export type OrgPatchResult =
  | { kind: "ok"; value: OrgSettingsResponse }
  | { kind: "conflict"; latest: OrgSettingsResponse }
  | { kind: "forbidden" }
  | { kind: "error"; status: number; message: string }

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  }
}

/**
 * GET /api/v2/orgs/:orgId/settings.
 * Returns null on 403/404/network error — callers treat absence as empty.
 */
export async function fetchOrgSettings(
  jwt: string,
  orgId: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<OrgSettingsResponse | null> {
  try {
    const res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/settings`, {
      headers: authHeaders(jwt),
    })
    if (!res.ok) return null
    return (await res.json()) as OrgSettingsResponse
  } catch {
    return null
  }
}

/**
 * PATCH /api/v2/orgs/:orgId/settings. Requires ifMatchVersion.
 * Non-maintainer callers get { kind: "forbidden" }.
 */
export async function patchOrgSettings(
  jwt: string,
  orgId: number,
  settings: OrgWideSettings,
  ifMatchVersion: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<OrgPatchResult> {
  let res: Response
  try {
    res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/settings`, {
      method: "PATCH",
      headers: authHeaders(jwt),
      body: JSON.stringify({ settings, ifMatchVersion }),
    })
  } catch (e) {
    return { kind: "error", status: 0, message: e instanceof Error ? e.message : String(e) }
  }

  if (res.ok) {
    const value = (await res.json()) as OrgSettingsResponse
    return { kind: "ok", value }
  }
  if (res.status === 409) {
    const body = (await res.json()) as { current?: OrgSettingsResponse }
    if (body.current) return { kind: "conflict", latest: body.current }
    return { kind: "error", status: res.status, message: "version conflict" }
  }
  if (res.status === 403) {
    return { kind: "forbidden" }
  }
  const text = await res.text().catch(() => "")
  return { kind: "error", status: res.status, message: text }
}

export type PromotionRequestResult =
  | { kind: "ok" }
  | { kind: "duplicate" }
  | { kind: "forbidden" }
  | { kind: "error"; status: number; message: string }

/**
 * POST /api/v2/orgs/:orgId/rule-promotion-requests.
 * Requires org role >= PROJECT_LEAD (500). Returns "duplicate" if an identical
 * request (same rule id + project) is already pending.
 */
export async function postPromotionRequest(
  jwt: string,
  orgId: number,
  rule: TranslationRule,
  sourceProjectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<PromotionRequestResult> {
  let res: Response
  try {
    res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/rule-promotion-requests`, {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({ rule, sourceProjectId }),
    })
  } catch (e) {
    return { kind: "error", status: 0, message: e instanceof Error ? e.message : String(e) }
  }
  if (res.ok) return { kind: "ok" }
  if (res.status === 409) return { kind: "duplicate" }
  if (res.status === 403) return { kind: "forbidden" }
  const text = await res.text().catch(() => "")
  return { kind: "error", status: res.status, message: text }
}
