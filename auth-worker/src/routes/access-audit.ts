/**
 * AQU-1072: GET /api/v2/orgs/:orgId/access-audit
 * Owners and Maintainers (and platform operators, who resolve as owner).
 * The body is buildAccessAudit — roles come from resolveProjectRoles.
 */

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { buildAccessAudit } from "../services/access-audit"
import { getEffectiveOrgRole } from "../services/org-permissions"
import { ROLE } from "../types"

const accessAudit = new Hono<AuthHonoEnv>()

accessAudit.get("/:orgId/access-audit", authMiddleware, async (c) => {
  const orgId = Number(c.req.param("orgId"))
  if (!Number.isSafeInteger(orgId) || orgId <= 0) return c.json({ error: "bad org id" }, 400)
  const role = await getEffectiveOrgRole(c.env, orgId, c.get("user"))
  if (role == null || role < ROLE.MAINTAINER) {
    return c.json({ error: "org role >= maintainer required" }, 403)
  }
  const report = await buildAccessAudit(c.env, orgId)
  if (!report) return c.json({ error: "not found" }, 404)
  return c.json(report)
})

export default accessAudit
