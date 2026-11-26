// AQU-2647: lane-grant levels carried on a sync token. Source text is shared
// across language lanes, so the editor only needs the levels, not which lane
// each one is for. The claim is omitted when the member has no grants.

function payload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1]
  if (!part) return null
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/")
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="))
    const parsed: unknown = JSON.parse(json)
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Role levels from `laneGrants` on a sync token. An absent or broken claim is none. */
export function laneGrantLevelsFromSyncToken(token: string): number[] {
  const grants = payload(token)?.laneGrants
  if (!Array.isArray(grants)) return []
  const levels: number[] = []
  for (const grant of grants) {
    if (grant && typeof grant === "object" && typeof (grant as { level?: unknown }).level === "number") {
      levels.push((grant as { level: number }).level)
    }
  }
  return levels
}
