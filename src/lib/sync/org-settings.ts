import { FRONTIER_API_URL } from "./sync-token"
import type { TranslationRule, PromotionRequest } from "@/lib/parsers/types"

/**
 * The synced subset of org-wide settings. Shape is intentionally open (server
 * is a dumb store) but we type the known keys.
 */
export interface OrgWideSettings {
  rules?: TranslationRule[]
  promotionRequests?: PromotionRequest[]
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
