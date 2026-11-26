/**
 * AQU-2323: the person inspector's History, from what is recorded today.
 *
 * There is no access event log of its own. Two sources exist, and this reads
 * both rather than adding a third:
 *   - each live grant row's granted_by / granted_at ("granted");
 *   - admin_audit_log rows naming this person as the target. That table is
 *     written only when the actor is a platform admin (services/admin-audit.ts),
 *     so a role change or removal by an ordinary Owner leaves no trace.
 * Invite acceptance and lane-grant changes are recorded nowhere, so they are
 * never listed.
 *
 * Every entry names a place in the viewer's tree; anything else is dropped,
 * so history cannot name a place the lenses hide.
 */
import type { Env } from "../types"
import type { ScopeRef } from "./access-payload"
import type { PersonGrantCard } from "./person-access"

export interface PersonHistoryEntry {
  kind: "granted" | "changed" | "removed"
  at: string
  by: string | null
  path: ScopeRef[]
  roleBefore: number | null
  roleAfter: number | null
}

const AUDIT_KIND: Record<string, PersonHistoryEntry["kind"]> = {
  "org.member.add": "granted",
  "org.member.role": "changed",
  "org.member.remove": "removed",
  "project.member.grant": "granted",
  "project.member.role": "changed",
  "project.member.remove": "removed",
  "project.member.revoke_all": "removed",
  "team.member.add": "granted",
  "team.member.role": "changed",
  "team.member.remove": "removed",
}

export interface AuditRow { action: string; detail: string; created_at: string | Date }

interface AuditDetail {
  actor?: { username?: string | null }
  target?: { userId?: number | string } | null
  scope?: string
  orgId?: number | string | null
  groupId?: number | string | null
  projectId?: string | null
  roleBefore?: number | null
  roleAfter?: number | null
}

function parse(detail: string): AuditDetail | null {
  try {
    const value: unknown = JSON.parse(detail)
    return value && typeof value === "object" ? (value as AuditDetail) : null
  } catch {
    return null
  }
}

/** Pure: audit rows → entries, keeping only this org and places in `paths` (`type:id` → path). */
export function auditHistory(
  rows: readonly AuditRow[],
  orgId: string,
  userId: string,
  paths: ReadonlyMap<string, ScopeRef[]>,
  cards: readonly PersonGrantCard[],
): PersonHistoryEntry[] {
  const out: PersonHistoryEntry[] = []
  for (const row of rows) {
    const kind = AUDIT_KIND[row.action]
    const detail = kind ? parse(row.detail) : null
    if (!kind || !detail || String(detail.target?.userId ?? "") !== userId) continue
    const place =
      detail.scope === "org" && String(detail.orgId ?? "") === orgId ? `org:${orgId}`
      : detail.scope === "team" && String(detail.orgId ?? "") === orgId && detail.groupId != null ? `team:${detail.groupId}`
      : detail.scope === "project" && detail.projectId ? `project:${detail.projectId}`
      : null
    const path = place ? paths.get(place) : undefined
    if (!place || !path) continue
    // A grant that still stands is already listed from its own row.
    if (kind === "granted" && cards.some((c) => `${c.grant.type}:${c.grant.id}` === place)) continue
    out.push({
      kind,
      at: new Date(row.created_at).toISOString(),
      by: detail.actor?.username ?? null,
      path,
      roleBefore: detail.roleBefore ?? null,
      roleAfter: detail.roleAfter ?? null,
    })
  }
  return out
}

/** Each standing direct grant with a recorded date, as "granted". */
export function grantedHistory(cards: readonly PersonGrantCard[]): PersonHistoryEntry[] {
  return cards
    .filter((c) => c.source === "direct" && c.grantedAt)
    .map((c) => ({ kind: "granted" as const, at: c.grantedAt as string, by: c.grantedBy, path: c.path, roleBefore: null, roleAfter: c.roleLevel }))
}

export function newestFirst(entries: PersonHistoryEntry[]): PersonHistoryEntry[] {
  return entries.sort((a, b) => b.at.localeCompare(a.at))
}

export async function loadAuditRows(env: Env, userId: string): Promise<AuditRow[]> {
  if (!/^\d{1,18}$/.test(userId)) return []
  const actions = Object.keys(AUDIT_KIND)
  // A LIKE prefilter on the JSON text; auditHistory re-checks the parsed target.
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT action, detail, created_at FROM admin_audit_log
      WHERE action IN (${actions.map(() => "?").join(", ")})
        AND detail LIKE ?
      ORDER BY created_at DESC
      LIMIT 200`,
  )
    .bind(...actions, `%"target":{"userId":${userId},%`)
    .all<AuditRow>()
  return results ?? []
}
