/**
 * AQU-1352 P0 — where may the caller create a project?
 * GET /api/v2/me/create-targets (auth-worker/src/routes/me.ts).
 */
import { FRONTIER_API_URL } from "./sync-token"
import { UserError } from "@/lib/errors/user-error"

export interface CreateTarget {
  kind: "org" | "personal"
  /** null for a personal workspace that does not exist yet; POST without
   *  orgId creates it. */
  orgId: number | null
  name: string
  path: string[]
  role: number
}

export async function fetchCreateTargets(
  jwt: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<CreateTarget[]> {
  const res = await fetch(`${apiUrl}/api/v2/me/create-targets`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new UserError(res.status, body, "project")
  }
  return (await res.json()) as CreateTarget[]
}
