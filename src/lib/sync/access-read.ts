/**
 * AQU-1352 P4 (spec §3.8 rule 2): the member-access payload.
 * GET /api/v2/users/:userId/access?from=<scopeType>:<scopeId>
 * (auth-worker/src/routes/access.ts). The server already filtered out every
 * grant the viewer may not see; render it as-is.
 */
import { FRONTIER_API_URL } from "./sync-token"
import { UserError } from "@/lib/errors/user-error"
import type { MemberAccess, ScopeType } from "@/lib/access/types"

export type AccessFromScope = { type: Exclude<ScopeType, "lane">; id: string }

export async function fetchMemberAccess(
  jwt: string,
  userId: number | string,
  from: AccessFromScope,
  apiUrl: string = FRONTIER_API_URL,
): Promise<MemberAccess> {
  const qs = new URLSearchParams({ from: `${from.type}:${from.id}` })
  const res = await fetch(`${apiUrl}/api/v2/users/${encodeURIComponent(String(userId))}/access?${qs}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new UserError(res.status, body, "project")
  }
  return (await res.json()) as MemberAccess
}
