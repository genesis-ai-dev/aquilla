/**
 * AQU-2323: the person inspector — "where can X go", as one viewer may see it.
 *
 * Pure. Every input is already viewer-filtered by GET /orgs/:id/access
 * (buildOrgAccess): the tree is the viewer's Places lens, the person's grant
 * entries are their People-lens row. This file only reads the person's own
 * grants through the resolver at each node of that tree, so it can name no
 * place, path or count the lenses would hide.
 *
 * The answer is keyed by place (`type:id`) and carries no viewer-specific
 * chrome, so an avatar popover or the Agent API members read can take the
 * same payload later.
 */
import type { AccessGrant, ChainLink } from "../../../db/shared/access-grants"
import { ORG_WIDE_ACCESS_FLOOR } from "../../../db/shared/project-roles"
import type { AccessChainEntry, ScopeRef, ScopeType } from "./access-payload"
import { laneRoleAt, resolveAt, type GrantTarget, type OrgWorld } from "./grant-preview"
import { withoutGrants, type GrantRef } from "./removal-preview"

type Account = Extract<GrantTarget, { kind: "account" }>
type LaneRow = Account["laneGrants"][number]

/** The person's effective role at one place. */
export interface PersonPlaceRole {
  roleLevel: number
  /** Granted at this place, reaching it from `via`, or the project's creator. */
  kind: "direct" | "inherited" | "creator"
  /** Inherited only: the place the role is set at. Hidden (no id, no name) when the viewer cannot see it. */
  via: ScopeRef | null
  /** Other paths that resolve to the same rung here. */
  alsoVia: ScopeRef[]
  /** The direct grant at this place adds nothing: removing it changes no place the viewer can see. */
  redundantDirect: boolean
}

export interface PersonPlaceNode {
  scope: ScopeRef
  role: PersonPlaceRole
  children: PersonPlaceNode[]
}

export type PlaceCounts = Record<ScopeType, number>

export interface PersonGrantCard {
  grant: GrantRef
  /** Outermost first, as the People lens names it. */
  path: ScopeRef[]
  roleLevel: number
  source: "direct" | "creator"
  grantedBy: string | null
  grantedByUserId: string | null
  grantedAt: string | null
  /** The places whose role would change without this grant, by kind. */
  gives: PlaceCounts
  /** Removing it changes no place the viewer can see. */
  redundant: boolean
}

export interface PersonAccessCore {
  counts: { grants: number; projects: number }
  /** The viewer's tree, cut down to the places this person reaches. Each place appears once. */
  tree: PersonPlaceNode[]
  /** Every place of the viewer's tree the person does not reach, in tree order. */
  noAccess: { places: { scope: ScopeRef; path: ScopeRef[] }[]; counts: PlaceCounts }
  grants: PersonGrantCard[]
}

interface PlaceNode { scope: ScopeRef; children: readonly PlaceNode[] }

interface Indexed { scope: ScopeRef; path: ScopeRef[]; projectId: string | null }

const key = (s: { type: string; id: string }) => `${s.type}:${s.id}`
const zero = (): PlaceCounts => ({ org: 0, team: 0, project: 0, lane: 0 })

/** Every distinct place of the tree, in walk order, with its first path. */
function indexTree(tree: readonly PlaceNode[]): Map<string, Indexed> {
  const out = new Map<string, Indexed>()
  const walk = (nodes: readonly PlaceNode[], path: ScopeRef[], projectId: string | null) => {
    for (const node of nodes) {
      const here = [...path, node.scope]
      const pid = node.scope.type === "project" ? node.scope.id : projectId
      if (!out.has(key(node.scope))) out.set(key(node.scope), { scope: node.scope, path: here, projectId: pid })
      walk(node.children, here, pid)
    }
  }
  walk(tree, [], null)
  return out
}

/**
 * Effective role at every place in `places`, without names of places the
 * viewer cannot see. `visible` is the set of `type:id` keys of their tree.
 */
function rolesAt(
  world: OrgWorld,
  grants: readonly AccessGrant[],
  laneRows: readonly LaneRow[],
  places: ReadonlyMap<string, Indexed>,
  visible: ReadonlySet<string>,
): Map<string, Omit<PersonPlaceRole, "redundantDirect">> {
  const shown = (ref: ScopeRef): ScopeRef =>
    visible.has(key(ref)) ? ref : { type: ref.type, id: ref.type === "org" ? ref.id : "", name: "", hidden: true }
  const team = (id: string | null): ScopeRef => {
    const found = world.teams.find((t) => t.id === id)
    return shown(found ? { type: "team", id: found.id, name: found.name } : { type: "team", id: id ?? "", name: "" })
  }
  const org = grants.find((g) => g.scopeType === "org" && g.scopeId === world.org.id) ?? null
  const orgWide = org && org.roleLevel >= ORG_WIDE_ACCESS_FLOOR ? org.roleLevel : null
  const out = new Map<string, Omit<PersonPlaceRole, "redundantDirect">>()

  const linkRef = (link: ChainLink, project: ScopeRef): ScopeRef | null => {
    if (link.source === "override") return project
    if (link.source === "group") return team(link.grant?.viaTeamId ?? null)
    if (link.source === "org") return shown(world.org)
    return null
  }

  for (const [k, place] of places) {
    const { scope } = place
    if (scope.type === "org") {
      if (org && scope.id === world.org.id) out.set(k, { roleLevel: org.roleLevel, kind: "direct", via: null, alsoVia: [] })
      continue
    }
    if (scope.type === "team") {
      const row = grants.find((g) => g.scopeType === "team" && g.scopeId === scope.id)
      // A membership stored without a team role still joins the team's projects.
      const legacy = grants.filter((g) => g.scopeType === "project" && g.source === "team" && g.viaTeamId === scope.id)
      const direct = row?.roleLevel ?? (legacy.length > 0 ? Math.max(...legacy.map((g) => g.roleLevel)) : null)
      if (direct == null && orgWide == null) continue
      if (direct != null && (orgWide == null || direct >= orgWide)) {
        out.set(k, { roleLevel: direct, kind: "direct", via: null, alsoVia: orgWide === direct ? [shown(world.org)] : [] })
      } else if (orgWide != null) {
        out.set(k, { roleLevel: orgWide, kind: "inherited", via: shown(world.org), alsoVia: [] })
      }
      continue
    }
    if (scope.type === "project") {
      const resolved = resolveAt(world, grants, scope.id)
      const top = resolved?.chain[0]
      if (!resolved || !top) continue
      const kind = top.source === "override" ? "direct" : top.source === "creator" ? "creator" : "inherited"
      const via = kind === "inherited" ? linkRef(top, scope) : null
      const alsoVia: ScopeRef[] = []
      for (const link of resolved.chain.slice(1)) {
        if (link.level !== resolved.level) continue
        const ref = linkRef(link, scope)
        if (ref && !alsoVia.some((r) => r.type === ref.type && r.id === ref.id) && !(via && via.type === ref.type && via.id === ref.id)) alsoVia.push(ref)
      }
      out.set(k, { roleLevel: resolved.level, kind, via, alsoVia })
      continue
    }
    // A lane: the project must open, and under the read wall the lane needs its own row.
    const projectId = place.projectId
    if (!projectId) continue
    const level = laneRoleAt(world, grants, laneRows, projectId, scope.id)
    if (level == null) continue
    const project = out.get(`project:${projectId}`) ?? null
    const projectRef = places.get(`project:${projectId}`)?.scope ?? { type: "project" as const, id: projectId, name: "" }
    const projectVia = project && project.kind === "inherited" && project.via ? project.via : projectRef
    const row = laneRows.find((r) => r.projectId === projectId && r.laneId === scope.id && r.roleLevel >= 100)
    const projectLevel = project?.roleLevel ?? 0
    if (row && row.roleLevel >= projectLevel) {
      const opensWithoutRow = world.wallOn !== true || projectLevel >= 600
      out.set(k, { roleLevel: level, kind: "direct", via: null, alsoVia: opensWithoutRow && row.roleLevel === projectLevel ? [projectVia] : [] })
    } else {
      out.set(k, { roleLevel: level, kind: "inherited", via: projectVia, alsoVia: [] })
    }
  }
  return out
}

/** The grant an entry of the person's People-lens row stands for, or null for a team-path project row. */
function entryGrant(entry: AccessChainEntry): { ref: GrantRef; source: "direct" | "creator" } | null {
  const last = entry.scopePath[entry.scopePath.length - 1]
  if (!last || entry.roleLevel == null) return null
  if (entry.origin.kind === "creator") return { ref: { type: "project", id: last.id }, source: "creator" }
  // A team-scope row is the team membership itself; a project row through a team is that team's, not a grant of its own.
  if (entry.origin.kind === "inherited" && last.type !== "team") return null
  if (entry.origin.kind !== "direct" && entry.origin.kind !== "inherited") return null
  return { ref: { type: last.type, id: last.id }, source: "direct" }
}

export function buildPersonAccess(input: {
  world: OrgWorld
  target: Account
  /** The viewer's Places-lens tree. */
  tree: readonly PlaceNode[]
  /** The person's People-lens grant entries (viewer-filtered, granters named). */
  entries: readonly AccessChainEntry[]
}): PersonAccessCore {
  const { world, target } = input
  const places = indexTree(input.tree)
  const visible = new Set(places.keys())
  const base = rolesAt(world, target.grants, target.laneGrants, places, visible)

  const grants: PersonGrantCard[] = []
  for (const entry of input.entries) {
    const found = entryGrant(entry)
    if (!found) continue
    const { ref, source } = found
    if (grants.some((g) => key(g.grant) === key(ref) && g.source === source)) continue
    const gives = zero()
    let changed = 0
    if (source === "direct") {
      const without = rolesAt(
        world,
        withoutGrants(world, target.grants, [ref]),
        ref.type === "lane" ? target.laneGrants.filter((r) => r.laneId !== ref.id) : target.laneGrants,
        places,
        visible,
      )
      for (const [k, place] of places) {
        if ((base.get(k)?.roleLevel ?? null) === (without.get(k)?.roleLevel ?? null)) continue
        gives[place.scope.type] += 1
        changed += 1
      }
    }
    grants.push({
      grant: ref,
      path: entry.scopePath,
      roleLevel: entry.roleLevel ?? 0,
      source,
      grantedBy: entry.grantedBy ?? null,
      grantedByUserId: entry.grantedByUserId ?? null,
      grantedAt: entry.grantedAt ?? null,
      gives,
      // A creator row cannot be removed, so it is never "safe to remove".
      redundant: source === "direct" && changed === 0,
    })
  }

  const redundantAt = new Set(grants.filter((g) => g.redundant).map((g) => key(g.grant)))
  const roleOf = (k: string): PersonPlaceRole | null => {
    const role = base.get(k)
    if (!role) return null
    return { ...role, redundantDirect: role.kind === "direct" && redundantAt.has(k) }
  }

  // Each reached place once. An unreached place's reached children move up to its parent.
  const placed = new Set<string>()
  const cut = (nodes: readonly PlaceNode[]): PersonPlaceNode[] =>
    nodes.flatMap((node): PersonPlaceNode[] => {
      const k = key(node.scope)
      const role = roleOf(k)
      if (!role || placed.has(k)) return cut(node.children)
      placed.add(k)
      return [{ scope: node.scope, role, children: cut(node.children) }]
    })
  const tree = cut(input.tree)

  const noAccess = { places: [] as { scope: ScopeRef; path: ScopeRef[] }[], counts: zero() }
  let projects = 0
  for (const [k, place] of places) {
    if (base.has(k)) {
      if (place.scope.type === "project") projects += 1
      continue
    }
    noAccess.places.push({ scope: place.scope, path: place.path })
    noAccess.counts[place.scope.type] += 1
  }
  return { counts: { grants: grants.length, projects }, tree, noAccess, grants }
}
