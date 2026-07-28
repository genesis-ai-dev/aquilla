// Walk the GitLab group tree → plan org/team structure → upsert it into NEON
// (via the trusted /migrate/groups + /migrate/users endpoints). This is the
// Neon replacement for scripts/migrate-groups.ts's old `wrangler d1` Layer A,
// folded into a reusable helper so the content delta (migrate-all) can create
// new orgs/teams inline — completing the D1→Neon cutover.
//
// I/O orchestration (GitLab REST + worker HTTP); the planning is delegated to
// the pure, unit-tested planGroupImport.

import {
  listTopLevelGroups,
  listDescendantGroups,
  listGroupMembers,
  listAllUsers,
} from "./gitlab/api"
import { planGroupImport, type GitLabSubgroupNode, type ResolvedMember, type GroupImportPlan } from "./groups"
import { orgLegacyUuidFor, teamLegacyUuidFor } from "./ids"
import type { GitLabCredentials } from "./gitlab/auth"

/** A GitLab namespace (full_path) → its aquilla org + (optional) team, by the
 *  stable legacy_uuids. Used to place each project. */
export interface Placement {
  orgLegacyUuid: string
  teamLegacyUuid: string | null
}

export interface GroupSyncResult {
  /** full_path → placement, for every group in the tree. */
  placeIdx: Map<string, Placement>
  /** The planned structure (orgs/teams/members + conflicts) — for reporting. */
  plan: GroupImportPlan
  /** legacy_uuid → id, after upsert (empty when apply=false). */
  orgIdByUuid: Map<string, number>
  teamIdByUuid: Map<string, number>
}

export interface GroupSyncHttp {
  /** Sync-worker base, e.g. https://api.aquilla.app/sync */
  syncBase: string
  /** Trusted headers (Authorization: Bearer SYNC_SECRET_KEY + content-type). */
  headers: Record<string, string>
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch
}

const lc = (v: string): string => v.trim().toLowerCase()

/**
 * Build the placement index + a group import plan from the live GitLab tree,
 * resolving members against Neon users, and (when apply) upsert orgs/teams/
 * members into Neon. Idempotent end-to-end (the endpoint dedups on legacy_uuid).
 */
export async function syncGroupsToNeon(
  creds: GitLabCredentials,
  http: GroupSyncHttp,
  opts: { apply: boolean },
): Promise<GroupSyncResult> {
  const doFetch = http.fetchFn ?? fetch

  // 1) Walk the tree once: placement index + effective members per group.
  const tops = await listTopLevelGroups(creds)
  const placeIdx = new Map<string, Placement>()
  const subgroups: GitLabSubgroupNode[] = []
  const rawMembersByGroupId = new Map<number, { id: number; username: string; access_level: number }[]>()
  const collect = async (groupId: number) => {
    const ms = await listGroupMembers(creds, groupId)
    rawMembersByGroupId.set(groupId, ms.map((m) => ({ id: m.id, username: m.username, access_level: m.access_level })))
  }
  for (const top of tops) {
    placeIdx.set(top.full_path, { orgLegacyUuid: orgLegacyUuidFor(top.id), teamLegacyUuid: null })
    await collect(top.id)
    for (const d of await listDescendantGroups(creds, top.id)) {
      placeIdx.set(d.full_path, { orgLegacyUuid: orgLegacyUuidFor(top.id), teamLegacyUuid: teamLegacyUuidFor(d.id) })
      subgroups.push({ id: d.id, name: d.name, full_path: d.full_path, topLevelId: top.id })
      await collect(d.id)
    }
  }

  // 2) Resolve members → aquilla user ids. Email is the reliable key (GitLab
  //    usernames drifted); fall back to username. Aquilla users come from Neon.
  const usersRes = await doFetch(`${http.syncBase}/migrate/users`, { headers: http.headers })
  if (!usersRes.ok) throw new Error(`migrate/users HTTP ${usersRes.status}: ${(await usersRes.text()).slice(0, 200)}`)
  const { users } = (await usersRes.json()) as { users: { id: number; username: string | null; email: string | null }[] }
  const glUsers = await listAllUsers(creds)
  const emailByGitlabId = new Map<number, string>()
  for (const u of glUsers) if (u.email) emailByGitlabId.set(u.id, lc(u.email))
  const idByEmail = new Map<string, number>()
  const idByName = new Map<string, number>()
  for (const u of users) {
    if (u.email) idByEmail.set(lc(u.email), u.id)
    if (u.username) idByName.set(lc(u.username), u.id)
  }
  const resolve = (m: { id: number; username: string }): number | null => {
    const email = emailByGitlabId.get(m.id)
    if (email && idByEmail.has(email)) return idByEmail.get(email)!
    return idByName.get(lc(m.username)) ?? null
  }
  const membersByGroupId = new Map<number, ResolvedMember[]>()
  for (const [gid, ms] of rawMembersByGroupId) {
    membersByGroupId.set(gid, ms.map((m) => ({ userId: resolve(m), username: m.username, access_level: m.access_level })))
  }

  // 3) Plan. existing={} → the plan lists every org/team; the endpoint's
  //    ON CONFLICT DO NOTHING makes re-sends no-ops, so we needn't read existing.
  const plan = planGroupImport({
    topGroups: tops.map((t) => ({ id: t.id, name: t.name, full_path: t.full_path })),
    subgroups,
    membersByGroupId,
    existing: { orgUuids: new Set(), teamUuids: new Set() },
  })

  if (!opts.apply) {
    return { placeIdx, plan, orgIdByUuid: new Map(), teamIdByUuid: new Map() }
  }

  // 4) Upsert into Neon, get back the legacy_uuid→id maps.
  const res = await doFetch(`${http.syncBase}/migrate/groups`, {
    method: "POST",
    headers: http.headers,
    body: JSON.stringify({ plan }),
  })
  if (!res.ok) throw new Error(`migrate/groups HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { orgIdByUuid: Record<string, number>; teamIdByUuid: Record<string, number> }
  return {
    placeIdx,
    plan,
    orgIdByUuid: new Map(Object.entries(body.orgIdByUuid)),
    teamIdByUuid: new Map(Object.entries(body.teamIdByUuid)),
  }
}
