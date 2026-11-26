/**
 * AQU-2319: the people half of GET /orgs/:id/access.
 *
 * Members and guests come from the grants the viewer may already see. Pending
 * invites and language-lane grants are added only when that place is in the
 * tree this response is about to send. Nothing here grants or removes access.
 */
import type { AccessChainEntry, NamedGrant, ScopeRef } from "./access-payload"
import { toEntry } from "./access-payload"
import type { AccessTreeNode, PlaceExtras, PlaceGrant } from "./org-access-places"
import type { LaneShape } from "./lane-shape"

export interface OrgAccessPerson {
  userId: string
  displayName: string
  /**
   * The key the write routes look an account up by (users.username, unique
   * case-insensitively). Null for invites and for an account whose users row
   * could not be read: nothing may be written for them by name.
   */
  username: string | null
  email: string | null
  isGuest: boolean
  lastActiveAt: string | null
  pendingInvite?: { expiresAt: string | null; roleLevel: number }
  grants: AccessChainEntry[]
}

type AccountGrant = PlaceGrant & NamedGrant

function indexPlaces(nodes: readonly AccessTreeNode[]) {
  const projects = new Map<string, string>()
  const lanes = new Set<string>()
  let hasOrg = false
  const walk = (list: readonly AccessTreeNode[]) => {
    for (const node of list) {
      if (node.scope.type === "org") hasOrg = true
      if (node.scope.type === "project") projects.set(node.scope.id, node.scope.name)
      if (node.scope.type === "lane") lanes.add(node.scope.id)
      walk(node.children)
    }
  }
  walk(nodes)
  return { projects, lanes, hasOrg }
}

export function assembleOrgPeople(input: {
  grants: readonly AccountGrant[]
  memberIds: ReadonlySet<string>
  lastActiveAt: ReadonlyMap<string, string | null>
  org: ScopeRef
  tree: readonly AccessTreeNode[]
  extras: PlaceExtras
  /** AQU-2322: which lane rows are lane grants, and whose project row is drawn as lanes. */
  laneShape: LaneShape
}): OrgAccessPerson[] {
  const people = new Map<string, OrgAccessPerson>()

  const addAccount = (userId: string, username: string | null, email: string | null): OrgAccessPerson => {
    const existing = people.get(userId)
    if (existing) {
      if (!existing.email && email) existing.email = email
      return existing
    }
    const person: OrgAccessPerson = {
      userId,
      displayName: username ?? userId,
      username,
      email,
      isGuest: !input.memberIds.has(userId),
      lastActiveAt: input.lastActiveAt.get(userId) ?? null,
      grants: [],
    }
    people.set(userId, person)
    return person
  }

  const places = indexPlaces(input.tree)
  // AQU-2322: the lane grants this response may name.
  const shownLaneGrants = input.extras.laneGrants.filter(
    (row) => places.lanes.has(row.laneId) && places.projects.has(row.projectId) && input.laneShape.isLaneGrant(row),
  )

  for (const grant of input.grants) {
    const person = addAccount(grant.userId, grant.userName, grant.email)
    // A project row drawn as lanes is listed as those lanes, so Reaches reads
    // "1 lane" rather than "1 project". Lanes this viewer cannot see leave the
    // plain project row, as before.
    const asLanes = grant.scopeType === "project" && grant.source === "direct" &&
      input.laneShape.narrowed(grant.userId, grant.scopeId) &&
      shownLaneGrants.some((row) => row.userId === grant.userId && row.projectId === grant.scopeId)
    if (!asLanes) person.grants.push(toEntry(grant))
  }

  for (const row of shownLaneGrants) {
    const lane = input.extras.lanes.find((item) => item.id === row.laneId && item.projectId === row.projectId)
    const projectName = places.projects.get(row.projectId)
    if (!lane || !projectName) continue
    const known = input.extras.laneUsers.get(row.userId)
    const person = addAccount(row.userId, known?.name ?? null, known?.email ?? null)
    person.grants.push({
      scopePath: [
        input.org,
        { type: "project", id: row.projectId, name: projectName },
        { type: "lane", id: lane.id, name: lane.name },
      ],
      roleLevel: row.roleLevel,
      origin: { kind: "direct" },
    })
  }

  const addInvite = (
    userId: string,
    email: string | null,
    roleLevel: number,
    expiresAt: string | null,
    grants: AccessChainEntry[],
  ) => {
    if (grants.length === 0 || people.has(userId)) return
    people.set(userId, {
      userId,
      displayName: email ?? userId,
      username: null,
      email,
      isGuest: false,
      lastActiveAt: null,
      pendingInvite: { expiresAt, roleLevel },
      grants,
    })
  }

  if (places.hasOrg) {
    for (const invite of input.extras.orgInvites) {
      addInvite(`invite:org:${invite.ref}`, invite.email, invite.roleLevel, invite.expiresAt, [{
        scopePath: [input.org],
        roleLevel: invite.roleLevel,
        origin: { kind: "direct" },
      }])
    }
  }

  for (const [projectId, invites] of input.extras.projectInvites) {
    const projectName = places.projects.get(projectId)
    if (!projectName) continue
    const project: ScopeRef = { type: "project", id: projectId, name: projectName }
    for (const invite of invites) {
      const grants: AccessChainEntry[] = invite.lanes.length === 0
        ? [{ scopePath: [input.org, project], roleLevel: invite.roleLevel, origin: { kind: "direct" } }]
        : input.extras.lanes
            .filter((lane) =>
              lane.projectId === projectId &&
              places.lanes.has(lane.id) &&
              invite.lanes.some((token) => token === lane.id || token === lane.legacyTag),
            )
            .map((lane) => ({
              scopePath: [input.org, project, { type: "lane", id: lane.id, name: lane.name }],
              roleLevel: invite.roleLevel,
              origin: { kind: "direct" as const },
            }))
      addInvite(`invite:project:${projectId}:${invite.ref}`, invite.email, invite.roleLevel, invite.expiresAt, grants)
    }
  }

  return [...people.values()].sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId),
  )
}
