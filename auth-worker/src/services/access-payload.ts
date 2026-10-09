/**
 * AQU-1352 P4 (spec §3.8 rules 1–6): the one member-access payload behind
 * GET /api/v2/users/:userId/access?from=<scopeType>:<scopeId>.
 *
 * Every grant comes from the `access_grants` view (migration 0119); the
 * "effective here" chain for a project comes from resolveProjectRoleViaGrants,
 * so the inspector explains the same answer the resolver computes. Rows the
 * VIEWER may not know about are dropped here, server-side (rule 4) — the
 * client never receives them.
 */

import type { Env, AuthUser } from "../types"
import {
  resolveProjectRoleViaGrants,
  type ChainLink,
} from "../../../db/shared/access-grants"
import { resolveProjectRole } from "./project-permissions"
import { platformAdminEmailsParam } from "../middleware/platform-admin"
import {
  canViewRoster,
  getEffectiveOrgRole,
  getProjectRosterViewMinRole,
  getRosterViewMinRole,
} from "./org-permissions"

// ── Wire shape ────────────────────────────────────────────────────────────
// Duplicated from src/lib/access/types.ts (the source of truth — the worker
// cannot import the SPA). Keep field names identical.
export type ScopeType = "org" | "team" | "project" | "lane"
export interface ScopeRef { type: ScopeType; id: string; name: string; hidden?: true }
export type ScopePath = ScopeRef[]
export interface GrantOrigin { kind: "direct" | "inherited" | "creator" | "platform"; from?: ScopePath }
export interface AccessChainEntry {
  scopePath: ScopePath
  roleLevel: number | null
  origin: GrantOrigin
  grantedBy?: string
  /** Account id of whoever granted this row. Set when `grantedBy` is their username. */
  grantedByUserId?: string
  grantedAt?: string
  descendantCount?: number
}
export interface MemberAccess {
  userId: string
  displayName: string
  isGuest: boolean
  effectiveHere: { roleLevel: number | null; chain: AccessChainEntry[] }
  elsewhere: AccessChainEntry[]
}

export interface FromScope { type: "org" | "team" | "project"; id: string }

export function parseFromScope(raw: string | undefined): FromScope | null {
  const m = /^(org|team|project):(.+)$/.exec(raw ?? "")
  return m ? { type: m[1] as FromScope["type"], id: m[2] } : null
}

// ── Grant rows, named ─────────────────────────────────────────────────────
export interface NamedGrantRow {
  scope_type: string
  scope_id: string
  role_level: number
  source: string
  via_team_id: number | string | null
  granted_by: number | string | null
  granted_at: string | Date | null
  org_id: number | string | null
  org_name: string | null
  team_id: number | string | null
  team_name: string | null
  project_name: string | null
}

export interface NamedGrant {
  scopeType: string
  scopeId: string
  roleLevel: number
  source: string
  viaTeamId: string | null
  grantedBy: string | null
  grantedAt: string | null
  orgId: number | null
  orgName: string | null
  teamId: string | null
  teamName: string | null
  projectName: string | null
}

const str = (v: number | string | null): string | null => (v == null ? null : String(v))

async function loadNamedGrants(env: Env, userId: number): Promise<NamedGrant[]> {
  // Team id: via_team_id for project-via-team rows, or scope_id when the view
  // grows scope_type='team' rows (handled generically, spec §3.2).
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT x.*, o.name AS org_name FROM (
       SELECT g.scope_type, g.scope_id, g.role_level, g.source, g.via_team_id,
              g.granted_by, g.granted_at,
              COALESCE(CASE WHEN g.scope_type = 'org' THEN g.scope_id::BIGINT END,
                       p.org_id, t.org_id) AS org_id,
              t.id AS team_id, t.name AS team_name, p.name AS project_name
         FROM access_grants g
         LEFT JOIN projects p ON g.scope_type = 'project' AND p.id = g.scope_id
         LEFT JOIN groups t ON t.id = COALESCE(g.via_team_id,
              CASE WHEN g.scope_type = 'team' THEN g.scope_id::BIGINT END)
        WHERE g.user_id = ?
          AND (g.scope_type <> 'project' OR p.archived_at IS NULL)
     ) x
     LEFT JOIN organizations o ON o.id = x.org_id`,
  )
    .bind(userId)
    .all<NamedGrantRow>()
  return (results ?? []).map(toNamedGrant)
}

/** Row → NamedGrant; shared with the org People & access read (routes/org-access.ts). */
export function toNamedGrant(r: NamedGrantRow): NamedGrant {
  return {
    scopeType: r.scope_type,
    scopeId: String(r.scope_id),
    roleLevel: Number(r.role_level),
    source: r.source,
    viaTeamId: str(r.via_team_id),
    grantedBy: str(r.granted_by),
    grantedAt: r.granted_at == null ? null : new Date(r.granted_at).toISOString(),
    orgId: r.org_id == null ? null : Number(r.org_id),
    orgName: r.org_name,
    teamId: str(r.team_id),
    teamName: r.team_name,
    projectName: r.project_name,
  }
}

const grantKey = (g: { scopeType: string; scopeId: string; source: string; viaTeamId: string | null }) =>
  `${g.scopeType}|${g.scopeId}|${g.source}|${g.viaTeamId ?? ""}`

function orgRef(g: NamedGrant): ScopeRef[] {
  return g.orgId == null ? [] : [{ type: "org", id: String(g.orgId), name: g.orgName ?? `Organization ${g.orgId}` }]
}
function teamRef(g: NamedGrant): ScopeRef[] {
  return g.teamId == null ? [] : [{ type: "team", id: g.teamId, name: g.teamName ?? `Team ${g.teamId}` }]
}

/** Where the grant lives, outermost first: org › [team] › project. */
function scopePathOf(g: NamedGrant): ScopePath {
  if (g.scopeType === "org") return orgRef(g)
  if (g.scopeType === "team") return [...orgRef(g), ...teamRef(g)]
  if (g.scopeType === "project") {
    return [...orgRef(g), ...teamRef(g), { type: "project", id: g.scopeId, name: g.projectName ?? g.scopeId }]
  }
  // SWARM-TODO(AQU-1352): lane rows (Luke's lane grants) are not in the view yet.
  return [...orgRef(g), { type: g.scopeType as ScopeType, id: g.scopeId, name: g.scopeId }]
}

function originOf(g: NamedGrant): GrantOrigin {
  if (g.source === "creator") return { kind: "creator" }
  if (g.source === "team" || g.scopeType === "team") return { kind: "inherited", from: [...orgRef(g), ...teamRef(g)] }
  return { kind: "direct" }
}

// ── Viewer visibility (rule 4) ────────────────────────────────────────────
export class ViewerScope {
  private orgRoles = new Map<number, number | null>()
  private rosterFloors = new Map<number, number>()
  private projectFloors = new Map<number, number>()
  private projectRoles = new Map<string, number | null>()

  constructor(private env: Env, readonly viewer: AuthUser) {}

  async orgRole(orgId: number): Promise<number | null> {
    if (!this.orgRoles.has(orgId)) this.orgRoles.set(orgId, await getEffectiveOrgRole(this.env, orgId, this.viewer))
    return this.orgRoles.get(orgId) ?? null
  }
  private async rosterFloor(orgId: number): Promise<number> {
    if (!this.rosterFloors.has(orgId)) this.rosterFloors.set(orgId, await getRosterViewMinRole(this.env, orgId))
    return this.rosterFloors.get(orgId) as number
  }
  private async projectFloor(orgId: number): Promise<number> {
    if (!this.projectFloors.has(orgId)) this.projectFloors.set(orgId, await getProjectRosterViewMinRole(this.env, orgId))
    return this.projectFloors.get(orgId) as number
  }
  async projectRole(projectId: string): Promise<number | null> {
    if (!this.projectRoles.has(projectId)) {
      const r = await resolveProjectRole(this.env, this.viewer, projectId)
      this.projectRoles.set(projectId, r?.level ?? null)
    }
    return this.projectRoles.get(projectId) ?? null
  }

  /** Org/team-level knowledge: org admin, or the org roster is listable to them. */
  async canSeeOrg(orgId: number): Promise<boolean> {
    const role = await this.orgRole(orgId)
    return (role ?? 0) >= 600 || canViewRoster(role, await this.rosterFloor(orgId))
  }

  /** A project the viewer can open AND whose roster the org lets them list. */
  async canSeeProject(projectId: string, orgId: number | null): Promise<boolean> {
    if (orgId != null && ((await this.orgRole(orgId)) ?? 0) >= 600) return true
    const role = await this.projectRole(projectId)
    if (role == null) return false
    return orgId == null || canViewRoster(role, await this.projectFloor(orgId))
  }
}

async function orgOfScope(env: Env, from: FromScope): Promise<{ exists: boolean; orgId: number | null }> {
  if (from.type === "org") {
    const row = await env.AQUILLA_PG.prepare("SELECT id FROM organizations WHERE id::TEXT = ?")
      .bind(from.id).first<{ id: number }>()
    return { exists: !!row, orgId: row ? Number(row.id) : null }
  }
  const sql = from.type === "team"
    ? "SELECT org_id FROM groups WHERE id::TEXT = ?"
    : "SELECT org_id FROM projects WHERE id = ?"
  const row = await env.AQUILLA_PG.prepare(sql).bind(from.id).first<{ org_id: number | null }>()
  return { exists: !!row, orgId: row?.org_id == null ? null : Number(row.org_id) }
}

export type AccessPayloadResult =
  | { ok: true; payload: MemberAccess }
  | { ok: false; status: 403 | 404; error: string }

export async function buildMemberAccess(
  env: Env,
  viewer: AuthUser,
  subjectId: number,
  from: FromScope,
): Promise<AccessPayloadResult> {
  const subject = await env.AQUILLA_PG.prepare(
    "SELECT id, username, email, display_name FROM users WHERE id = ?",
  )
    .bind(subjectId)
    .first<{ id: number; username: string; email: string; display_name: string | null }>()
  if (!subject) return { ok: false, status: 404, error: "user not found" }

  const scope = await orgOfScope(env, from)
  if (!scope.exists) return { ok: false, status: 404, error: "scope not found" }

  const isSelf = Number(viewer.id) === Number(subjectId)
  const vs = new ViewerScope(env, viewer)
  if (!isSelf) {
    const allowed = from.type === "project"
      ? await vs.canSeeProject(from.id, scope.orgId)
      : scope.orgId != null && (await vs.canSeeOrg(scope.orgId))
    if (!allowed) return { ok: false, status: 403, error: "no access to this roster" }
  }

  const grants = await loadNamedGrants(env, subjectId)
  const byKey = new Map(grants.map((g) => [grantKey(g), g]))

  // Effective here + the grants it consumed.
  const used = new Set<string>()
  let hereLevel: number | null = null
  const chain: AccessChainEntry[] = []
  if (from.type === "project") {
    const resolved = await resolveProjectRoleViaGrants(
      env.AQUILLA_PG,
      { id: String(subjectId), email: subject.email },
      from.id,
      await platformAdminEmailsParam(env),
    )
    hereLevel = resolved?.level ?? null
    for (const link of resolved?.chain ?? []) {
      const entry = chainEntry(link, byKey)
      if (entry.key) used.add(entry.key)
      chain.push(entry.entry)
    }
  } else {
    // Generic over scope_type: org grants today, team rows once the view has them.
    const here = grants
      .filter((g) => g.scopeType === from.type && g.scopeId === from.id)
      .sort((a, b) => b.roleLevel - a.roleLevel)
    for (const g of here) {
      used.add(grantKey(g))
      chain.push(toEntry(g))
    }
    hereLevel = here[0]?.roleLevel ?? null
  }

  const elsewhere: AccessChainEntry[] = []
  for (const g of grants) {
    if (used.has(grantKey(g))) continue
    if (!isSelf && !(await visibleTo(vs, g))) continue
    elsewhere.push(toEntry(g))
  }
  elsewhere.sort((a, b) => pathText(a.scopePath).localeCompare(pathText(b.scopePath)))

  countDescendants(elsewhere, [...chain, ...elsewhere])
  if (!isSelf) await hideUnseenAncestors(vs, [...chain, ...elsewhere])
  await nameGranters(env, [...chain, ...elsewhere])

  const isGuest = scope.orgId == null
    ? false
    : !(await env.AQUILLA_PG.prepare("SELECT 1 AS x FROM org_members WHERE org_id = ? AND user_id = ?")
        .bind(scope.orgId, subjectId).first<{ x: number }>())

  return {
    ok: true,
    payload: {
      userId: String(subjectId),
      // AQU-1411: the chip's label is the account username. users.display_name
      // is a real name and stays off this payload, matching the AQU-1180 rule
      // that a scrubbed identity is not filled back in from another column.
      displayName: subject.username,
      isGuest,
      effectiveHere: { roleLevel: hereLevel, chain },
      elsewhere,
    },
  }
}

export async function visibleTo(vs: ViewerScope, g: NamedGrant): Promise<boolean> {
  if (g.scopeType === "project") return vs.canSeeProject(g.scopeId, g.orgId)
  return g.orgId != null && vs.canSeeOrg(g.orgId)
}

/**
 * Spec §3.8 rule 1: containers show "▸ N projects". Counted from `visible`
 * (entries already filtered for the viewer), so the count leaks nothing.
 */
function countDescendants(targets: AccessChainEntry[], visible: AccessChainEntry[]): void {
  const projects = visible
    .map((e) => e.scopePath)
    .filter((p) => p[p.length - 1]?.type === "project")
  for (const e of targets) {
    const c = e.scopePath[e.scopePath.length - 1]
    if (c?.type !== "org" && c?.type !== "team") continue
    const ids = new Set(
      projects.filter((p) => p.some((r) => r.type === c.type && r.id === c.id)).map((p) => p[p.length - 1].id),
    )
    e.descendantCount = ids.size
  }
}

/**
 * Spec §3.9 rule 4: org/team crumbs the viewer cannot see are marked hidden
 * and their real names are replaced with "" — the name never leaves the
 * server. Covers both the grant's own path and its inherited-from path.
 */
/** Blank out org/team crumbs (name "" + hidden) — for a viewer who cannot see the org. */
export function redactOrgCrumbs(path: ScopePath): ScopePath {
  return path.map((r) => (r.type === "org" || r.type === "team" ? { type: r.type, id: r.id, name: "", hidden: true } : r))
}

export async function hideUnseenAncestors(vs: ViewerScope, entries: AccessChainEntry[]): Promise<void> {
  const redact = async (path: ScopePath): Promise<ScopePath> => {
    const orgId = path[0]?.type === "org" ? Number(path[0].id) : null
    if (orgId == null || (await vs.canSeeOrg(orgId))) return path
    return redactOrgCrumbs(path)
  }
  for (const e of entries) {
    e.scopePath = await redact(e.scopePath)
    if (e.origin.from) e.origin = { ...e.origin, from: await redact(e.origin.from) }
  }
}

const pathText = (p: ScopePath) => p.map((r) => r.name).join(" › ")

// grantedBy carries a user id until nameGranters swaps in the username.
export function toEntry(g: NamedGrant): AccessChainEntry {
  return {
    scopePath: scopePathOf(g),
    roleLevel: g.roleLevel,
    origin: originOf(g),
    ...(g.grantedBy ? { grantedBy: g.grantedBy } : {}),
    ...(g.grantedAt ? { grantedAt: g.grantedAt } : {}),
  }
}

function chainEntry(link: ChainLink, byKey: Map<string, NamedGrant>): { key: string | null; entry: AccessChainEntry } {
  if (!link.grant) return { key: null, entry: { scopePath: [], roleLevel: link.level, origin: { kind: "platform" } } }
  // resolveFromGrants stamps viaTeamId onto team-scope rows; the view row has none.
  const key = grantKey(link.grant.scopeType === "team" ? { ...link.grant, viaTeamId: null } : link.grant)
  const named = byKey.get(key)
  if (!named) return { key, entry: { scopePath: [], roleLevel: link.level, origin: { kind: "direct" } } }
  const entry = toEntry(named)
  // The org path contributes the resolver's level (AQU-1274 orgPathContribution), not the raw row.
  entry.roleLevel = link.level
  if (link.source === "org") entry.origin = { kind: "inherited", from: scopePathOf(named) }
  return { key, entry }
}

export async function nameGranters(env: Env, entries: AccessChainEntry[]): Promise<void> {
  const ids = [...new Set(entries.map((e) => e.grantedBy).filter((v): v is string => !!v))]
  if (ids.length === 0) return
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT id, username AS name FROM users
      WHERE id::TEXT IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .all<{ id: number; name: string }>()
  const names = new Map((results ?? []).map((r) => [String(r.id), r.name]))
  for (const e of entries) {
    if (!e.grantedBy) continue
    const n = names.get(e.grantedBy)
    if (n) {
      e.grantedByUserId = e.grantedBy
      e.grantedBy = n
    } else delete e.grantedBy
  }
}
