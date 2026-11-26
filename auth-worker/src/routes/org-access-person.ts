/**
 * AQU-2323: GET /api/v2/orgs/:orgId/access/people/:userId — the person
 * inspector. One read: the person's effective role at every place of the
 * viewer's tree (with the path that gives it), their direct grants, the places
 * they cannot reach, and their history.
 *
 * Visibility is the Places and People lenses', reused rather than restated:
 * the payload is built from buildOrgAccess for this viewer, the person must
 * be a non-invite row of its roster, and every place named is a node of its
 * tree. Every miss (an org the viewer sees nothing of, one that does not
 * exist, a person their roster does not show, a user that does not exist) is
 * the identical 403, so none can be told apart.
 */
import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ViewerScope, nameGranters, type AccessChainEntry, type ScopeRef } from "../services/access-payload"
import { loadGrantTarget, loadGrantWorld, withLaneView } from "../services/grant-preview-load"
import { buildPersonAccess, type PersonAccessCore } from "../services/person-access"
import { auditHistory, grantedHistory, loadAuditRows, newestFirst, type PersonHistoryEntry } from "../services/person-history"
import { buildOrgAccess } from "./org-access"

export interface PersonAccessPayload extends PersonAccessCore {
  person: {
    userId: string
    displayName: string
    username: string | null
    email: string | null
    isGuest: boolean
    lastActiveAt: string | null
  }
  history: PersonHistoryEntry[]
}

interface TreeNode { scope: ScopeRef; children: readonly TreeNode[] }

function treePaths(tree: readonly TreeNode[]): Map<string, ScopeRef[]> {
  const out = new Map<string, ScopeRef[]>()
  const walk = (nodes: readonly TreeNode[], path: ScopeRef[]) => {
    for (const node of nodes) {
      const here = [...path, node.scope]
      const k = `${node.scope.type}:${node.scope.id}`
      if (!out.has(k)) out.set(k, here)
      walk(node.children, here)
    }
  }
  walk(tree, [])
  return out
}

const orgAccessPerson = new Hono<AuthHonoEnv>()

orgAccessPerson.get("/:orgId/access/people/:userId", authMiddleware, async (c) => {
  const orgId = Number(c.req.param("orgId"))
  if (!Number.isSafeInteger(orgId) || orgId <= 0) return c.json({ error: "bad org id" }, 400)
  const hidden = () => c.json({ error: "no access to this roster" }, 403)
  const userId = c.req.param("userId") ?? ""
  if (!/^\d{1,18}$/.test(userId)) return hidden()

  const vs = new ViewerScope(c.env, c.get("user"))
  const access = await buildOrgAccess(c.env, vs, orgId)
  if (!access.ok) return hidden()
  const row = access.payload.people.find((p) => p.userId === userId && !p.pendingInvite)
  if (!row) return hidden()
  const loaded = await loadGrantWorld(c.env, vs, orgId)
  const target = loaded ? await loadGrantTarget(c.env, orgId, Number(userId)) : null
  if (!loaded || !target) return hidden()
  const world = withLaneView(loaded.world, access.payload.grantable, c.env.LANE_READ_WALL)

  // Lane grant entries are drawn from lane rows and carry no granter yet.
  const filled: AccessChainEntry[] = []
  const entries = row.grants.map((entry) => {
    const last = entry.scopePath[entry.scopePath.length - 1]
    if (last?.type !== "lane" || entry.grantedAt) return entry
    const lane = target.laneGrants.find((r) => r.laneId === last.id)
    if (!lane) return entry
    const copy: AccessChainEntry = {
      ...entry,
      ...(lane.grantedBy ? { grantedBy: lane.grantedBy } : {}),
      ...(lane.grantedAt ? { grantedAt: lane.grantedAt } : {}),
    }
    filled.push(copy)
    return copy
  })
  await nameGranters(c.env, filled)

  const core = buildPersonAccess({ world, target, tree: access.payload.tree, entries })
  const audit = auditHistory(await loadAuditRows(c.env, userId), String(orgId), userId, treePaths(access.payload.tree), core.grants)
  const payload: PersonAccessPayload = {
    person: {
      userId: row.userId,
      displayName: row.displayName,
      username: row.username,
      email: row.email,
      isGuest: row.isGuest,
      lastActiveAt: row.lastActiveAt,
    },
    ...core,
    history: newestFirst([...grantedHistory(core.grants), ...audit]),
  }
  return c.json(payload)
})

export default orgAccessPerson
