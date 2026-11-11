// AQU-2469: Admin → Platform → Dev access. Platform admins add and remove the
// emails that may use dev.aquilla.app, without a deploy. The gate itself and
// why the list lives in KV: services/dev-access.ts.
//
// Mounted from routes/admin.ts after requirePlatformAdmin and
// requireAdminElevation, so every route here needs a platform admin with an
// active step-up session.
//
// Routes (mounted at /api/v2/admin):
//   GET    /dev-access         — { enabled, entries }; enabled=false off dev
//   POST   /dev-access         — { email } → add (idempotent)
//   DELETE /dev-access/:email  — remove
//
// Off dev (production, previews, local) the list does nothing, so GET answers
// enabled=false and writes answer 409 rather than writing to a list nobody reads.

import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { AuthHonoEnv } from "../middleware/auth"
import {
  addDevAccess,
  DEV_ACCESS_EMAIL_MAX,
  devAccessGateActive,
  listDevAccess,
  normalizeDevAccessEmail,
  removeDevAccess,
} from "../services/dev-access"

const adminDevAccess = new Hono<AuthHonoEnv>()

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(DEV_ACCESS_EMAIL_MAX)
  .email({ message: "Enter a valid email address." })

const addSchema = z.object({ email: emailSchema })

const OFF_DEV = {
  error: "dev_access_off",
  message: "The dev access list only applies on dev.aquilla.app.",
}
const UNBOUND = {
  error: "dev_access_unbound",
  message: "The dev access list is not connected to this deployment.",
}

async function audit(c: Context<AuthHonoEnv>, action: string, email: string): Promise<void> {
  try {
    await c.env.AQUILLA_PG.prepare(`INSERT INTO admin_audit_log (user_id, action, detail) VALUES (?, ?, ?)`)
      .bind(c.get("user").id, action, JSON.stringify({ email }))
      .run()
  } catch (err) {
    console.error("[admin-dev-access] audit log failed:", err)
  }
}

/** The KV binding when the gate is on, or the response to send instead. */
function listBinding(c: Context<AuthHonoEnv>): KVNamespace | Response {
  if (!devAccessGateActive(c.env)) return c.json(OFF_DEV, 409)
  return c.env.DEV_ACCESS_LIST ?? c.json(UNBOUND, 503)
}

adminDevAccess.get("/dev-access", async (c) => {
  if (!devAccessGateActive(c.env)) return c.json({ enabled: false, entries: [] })
  const kv = c.env.DEV_ACCESS_LIST
  if (!kv) return c.json(UNBOUND, 503)
  return c.json({ enabled: true, entries: await listDevAccess(kv) })
})

adminDevAccess.post("/dev-access", zValidator("json", addSchema), async (c) => {
  const kv = listBinding(c)
  if (kv instanceof Response) return kv
  const { email } = c.req.valid("json")
  const entry = await addDevAccess(kv, email, c.get("user").email)
  await audit(c, "dev_access.add", email)
  return c.json({ entry }, 201)
})

adminDevAccess.delete("/dev-access/:email", async (c) => {
  const kv = listBinding(c)
  if (kv instanceof Response) return kv
  const email = normalizeDevAccessEmail(decodeURIComponent(c.req.param("email")))
  if (!email || email.length > DEV_ACCESS_EMAIL_MAX) return c.json({ error: "bad_email" }, 400)
  await removeDevAccess(kv, email)
  await audit(c, "dev_access.remove", email)
  return c.json({ ok: true })
})

export default adminDevAccess
