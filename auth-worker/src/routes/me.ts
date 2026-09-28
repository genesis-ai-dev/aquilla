/**
 * /api/v2/me/* — caller-scoped reads.
 *
 * AQU-1352 P0 (spec 3.5, 3.9 rule 5): GET /create-targets lists every place
 * the caller may create a project, so the create dialog can offer a picker
 * instead of silently posting into whatever org the page happened to have.
 * A user who is org Guest + team Owner (Tim) must see "Personal" as a valid
 * destination rather than hit a 403.
 */

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { isPlatformAdminEmail } from "../middleware/platform-admin"
import { ROLE } from "../types"

export interface CreateTarget {
  kind: "org" | "personal"
  /** null only for a personal org that does not exist yet (POST creates it). */
  orgId: number | null
  name: string
  path: string[]
  role: number
}

const me = new Hono<AuthHonoEnv>()

me.get("/create-targets", authMiddleware, async (c) => {
  const user = c.get("user")
  const env = c.env

  // Same lookup as getOrCreateUserOrg, minus the lazy insert: a GET must not
  // create an org as a side effect.
  const personal = await env.AQUILLA_PG.prepare(
    "SELECT id, name FROM organizations WHERE owner_user_id = ? ORDER BY id ASC LIMIT 1",
  )
    .bind(user.id)
    .first<{ id: number; name: string | null }>()

  const isAdmin = isPlatformAdminEmail(env, user.email)
  // Mirrors getEffectiveOrgRole: platform operators resolve as owner (700)
  // on every org; everyone else needs a membership row >= maintainer.
  const rows = isAdmin
    ? await env.AQUILLA_PG.prepare(
        `SELECT o.id AS id, o.name AS name, GREATEST(COALESCE(om.role_level, 0), 700) AS role
         FROM organizations o
         LEFT JOIN org_members om ON om.org_id = o.id AND om.user_id = ?
         ORDER BY o.name ASC, o.id ASC`,
      )
        .bind(user.id)
        .all<{ id: number; name: string | null; role: number }>()
    : await env.AQUILLA_PG.prepare(
        `SELECT o.id AS id, o.name AS name, om.role_level AS role
         FROM org_members om
         INNER JOIN organizations o ON o.id = om.org_id
         WHERE om.user_id = ? AND om.role_level >= ?
         ORDER BY o.name ASC, o.id ASC`,
      )
        .bind(user.id, ROLE.MAINTAINER)
        .all<{ id: number; name: string | null; role: number }>()

  const personalId = personal ? Number(personal.id) : null
  const personalName = personal?.name ?? `${user.username}'s workspace`
  const targets: CreateTarget[] = [
    {
      kind: "personal",
      orgId: personalId,
      name: personalName,
      path: [personalName],
      role: 700,
    },
  ]
  for (const r of rows.results ?? []) {
    const id = Number(r.id)
    if (id === personalId) continue
    const name = r.name ?? `Organization ${id}`
    // SWARM-TODO(AQU-1352): path is flat until org > team nesting lands.
    targets.push({ kind: "org", orgId: id, name, path: [name], role: Number(r.role) })
  }
  return c.json(targets)
})

export default me
