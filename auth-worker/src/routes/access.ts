/**
 * AQU-1352 P4 (spec §3.8 rule 2): GET /api/v2/users/:userId/access?from=<org|team|project>:<id>
 * — the one payload the member inspector, People & access and the audit
 * export all render. Viewer filtering lives in services/access-payload.ts.
 */

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { buildMemberAccess, parseFromScope } from "../services/access-payload"

const access = new Hono<AuthHonoEnv>()

access.get("/:userId/access", authMiddleware, async (c) => {
  const userId = Number(c.req.param("userId"))
  const from = parseFromScope(c.req.query("from"))
  if (!Number.isSafeInteger(userId) || userId <= 0 || !from) {
    return c.json({ error: "expected /users/:userId/access?from=<org|team|project>:<id>" }, 400)
  }
  const result = await buildMemberAccess(c.env, c.get("user"), userId, from)
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.payload)
})

export default access
