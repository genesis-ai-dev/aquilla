/**
 * The People & access folder tree: the organization is the root folder,
 * folders (teams in the data) are optional subfolders, projects are folders
 * with source files and settings, and languages (lanes) are the leaves.
 * Access set on any of them reaches everything inside.
 */
import { placeParam } from "@/lib/access/place-lens"
import type { ScopeRef } from "@/lib/access/types"

import type { AccessTreeNode, DirectGrantee, InheritedSource } from "./org-access-data"

export interface FolderNode {
  node: AccessTreeNode
  /** Outermost first, this place last. */
  path: ScopeRef[]
  children: FolderNode[]
}

/**
 * The server tree as folders. A project attached to two folders appears
 * under each of them in the server tree; a folder tree shows it once, under
 * the first. Its other folders' access still reaches it and is listed on it
 * as access from above (the server puts that in `inherited`). Folders come
 * before projects, each group by name; languages keep the server's order.
 */
export function accessFolders(tree: readonly AccessTreeNode[]): FolderNode[] {
  const seen = new Set<string>()
  const walk = (nodes: readonly AccessTreeNode[], path: ScopeRef[]): FolderNode[] => {
    const out: FolderNode[] = []
    for (const node of nodes) {
      const key = placeParam(node.scope)
      if (seen.has(key)) continue
      seen.add(key)
      const here = [...path, node.scope]
      out.push({ node, path: here, children: walk(node.children, here) })
    }
    return out
  }
  const byName = (a: FolderNode, b: FolderNode) => a.node.scope.name.localeCompare(b.node.scope.name)
  const order = (folders: FolderNode[]): FolderNode[] => {
    const of = (type: ScopeRef["type"]) => folders.filter((f) => f.node.scope.type === type)
    return [...of("org"), ...of("team").sort(byName), ...of("project").sort(byName), ...of("lane")]
  }
  const sortTree = (folders: FolderNode[]): FolderNode[] =>
    order(folders).map((f) => ({ ...f, children: sortTree(f.children) }))
  return sortTree(walk(tree, []))
}

/** Someone who can open this place because of a grant set higher up. */
export interface InheritedPerson {
  userId: string
  displayName: string
  roleLevel: number
  isGuest: boolean
  from: ScopeRef
}

/** A team whose grant on the project reaches this place. */
export interface InheritedTeam {
  team: ScopeRef
  roleLevel: number
  memberCount: number
}

/**
 * Who reaches a place from above, for the list under the people added there.
 * One line per person, with the highest role that reaches them and where it
 * is set. People added at this place are already listed above it, so they
 * are left out here.
 */
export function inheritedAccess(
  direct: readonly DirectGrantee[],
  inherited: readonly InheritedSource[],
): { people: InheritedPerson[]; teams: InheritedTeam[] } {
  const here = new Set(direct.map((d) => d.userId))
  const people = new Map<string, InheritedPerson>()
  const teams = new Map<string, InheritedTeam>()
  for (const source of inherited) {
    if (source.kind === "team") {
      const prior = teams.get(source.from.id)
      if (!prior || source.roleLevel > prior.roleLevel) {
        teams.set(source.from.id, { team: source.from, roleLevel: source.roleLevel, memberCount: source.memberCount ?? 0 })
      }
      continue
    }
    const userId = source.userId ?? source.from.id
    if (here.has(userId)) continue
    const prior = people.get(userId)
    if (prior && prior.roleLevel >= source.roleLevel) continue
    people.set(userId, {
      userId,
      displayName: source.displayName ?? userId,
      roleLevel: source.roleLevel,
      isGuest: source.isGuest ?? false,
      from: source.from,
    })
  }
  const byRole = <T extends { roleLevel: number }>(a: T, b: T) => b.roleLevel - a.roleLevel
  return {
    people: [...people.values()].sort((a, b) => byRole(a, b) || a.displayName.localeCompare(b.displayName)),
    teams: [...teams.values()].sort((a, b) => byRole(a, b) || a.team.name.localeCompare(b.team.name)),
  }
}

/** What a "+" on this place can create. Folders sit only directly under the organization; languages are leaves. */
export function newChildKinds(type: ScopeRef["type"]): ("team" | "project" | "lane")[] {
  if (type === "org") return ["team", "project"]
  if (type === "team") return ["project"]
  if (type === "project") return ["lane"]
  return []
}
