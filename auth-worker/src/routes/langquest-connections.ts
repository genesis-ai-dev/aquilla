// Account-level LangQuest connections — mounted at /api/v2/langquest beside
// routes/langquest.ts (src/index.ts).
//
//   GET    /connections                   signed in — the caller's connections (never a token), with health
//   POST   /connections                   signed in — { token }: checked with LangQuest, stored encrypted for
//                                         (caller, token's org); refreshes an existing connection to that org
//                                         and every project link made from it. Returns the languages too.
//   GET    /connections/:id/languages     owner — asks LangQuest what the stored token reaches now (a health probe)
//   POST   /connections/:id/check         owner — the same probe, connection only
//   DELETE /connections/:id               owner — forget it (?revoke=1 also revokes the token at LangQuest)
//
// A connection belongs to the user who pasted the token: LangQuest tokens are
// personal, so another member of the same Aquilla org never sees or uses it.
// Links made from it keep their own token copy (routes/langquest.ts), which is
// why disconnecting leaves linked projects importing until their token stops
// working.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Context } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { MondayForeignConnectionError } from "../lib/monday/tokens"
import { LangQuestApiError, LangQuestClient, langquestApiBase, type LangQuestMe } from "../lib/langquest/client"
import { getLangQuestToken } from "../lib/langquest/tokens"
import {
  connectionOut,
  getOwnConnection,
  linkedProjectCounts,
  listConnections,
  recordProbe,
  upsertConnection,
  type ConnectionRow,
} from "../lib/langquest/connections"

const connections = new Hono<AuthHonoEnv>()

const tokenSchema = z.object({ token: z.string().trim().regex(/^lqp_[A-Za-z0-9_-]{16,}$/, "not a LangQuest token") })

function failure(c: Context<AuthHonoEnv>, err: unknown): Response {
  if (err instanceof MondayForeignConnectionError) {
    return c.json({ error: err.message, reason: "foreign_environment", needsReauth: true }, 409)
  }
  if (err instanceof LangQuestApiError) {
    const status = err.tokenRejected ? 401 : err.status === 403 ? 403 : 502
    return c.json({ error: err.message, reason: err.code ?? "langquest_error", needsReauth: err.tokenRejected }, status)
  }
  console.warn("[langquest] connection request failed:", err)
  return c.json({ error: "Couldn't reach LangQuest", reason: "unreachable" }, 502)
}

async function withCount(c: Context<AuthHonoEnv>, row: ConnectionRow) {
  const counts = await linkedProjectCounts(c.env, [row.id])
  return connectionOut(row, counts.get(row.id) ?? 0)
}

connections.get("/connections", authMiddleware, async (c) => {
  const rows = await listConnections(c.env, c.get("user").id)
  const counts = await linkedProjectCounts(
    c.env,
    rows.map((r) => r.id),
  )
  return c.json({ connections: rows.map((r) => connectionOut(r, counts.get(r.id) ?? 0)) })
})

connections.post("/connections", authMiddleware, zValidator("json", tokenSchema), async (c) => {
  const { token } = c.req.valid("json")
  const base = langquestApiBase(c.env)
  let me: LangQuestMe
  try {
    me = await new LangQuestClient(base, token).me()
  } catch (err) {
    return failure(c, err)
  }
  const row = await upsertConnection(c.env, c.get("user").id, token, base, me)
  return c.json({ connection: await withCount(c, row), languages: me.languages }, 200)
})

/**
 * Ask LangQuest what the stored token reaches now, and record the answer as
 * the connection's health. A 401 is the verdict the UI's "needs reconnect"
 * state waits for; a network failure is noted but is not one.
 */
async function probe(
  c: Context<AuthHonoEnv>,
  row: ConnectionRow,
): Promise<{ row: ConnectionRow; me: LangQuestMe } | Response> {
  let token: string
  try {
    token = await getLangQuestToken(c.env, row)
  } catch (err) {
    if (err instanceof MondayForeignConnectionError) {
      await recordProbe(c.env, row.id, { rejected: true, error: err.message })
    }
    return failure(c, err)
  }
  try {
    const me = await new LangQuestClient(row.api_base, token).me()
    await recordProbe(c.env, row.id, { rejected: false, error: null, me })
    const fresh = await getOwnConnection(c.env, c.get("user").id, row.id)
    return { row: fresh ?? row, me }
  } catch (err) {
    const rejected = err instanceof LangQuestApiError && err.tokenRejected
    await recordProbe(c.env, row.id, { rejected, error: err instanceof Error ? err.message : String(err) })
    return failure(c, err)
  }
}

async function ownConnection(c: Context<AuthHonoEnv>): Promise<ConnectionRow | Response> {
  const row = await getOwnConnection(c.env, c.get("user").id, c.req.param("id") ?? "")
  return row ?? c.json({ error: "no such LangQuest connection" }, 404)
}

connections.get("/connections/:id/languages", authMiddleware, async (c) => {
  const row = await ownConnection(c)
  if (row instanceof Response) return row
  const probed = await probe(c, row)
  if (probed instanceof Response) return probed
  return c.json({ connection: await withCount(c, probed.row), languages: probed.me.languages })
})

connections.post("/connections/:id/check", authMiddleware, async (c) => {
  const row = await ownConnection(c)
  if (row instanceof Response) return row
  const probed = await probe(c, row)
  if (probed instanceof Response) {
    // The probe's verdict is recorded; say what the connection looks like now.
    const after = await getOwnConnection(c.env, c.get("user").id, row.id)
    const body = (await probed.json()) as Record<string, unknown>
    return c.json({ ...body, connection: after ? await withCount(c, after) : null }, probed.status as 401 | 403 | 409 | 502)
  }
  return c.json({ connection: await withCount(c, probed.row) })
})

connections.delete("/connections/:id", authMiddleware, async (c) => {
  const row = await ownConnection(c)
  if (row instanceof Response) return row
  let revoked = false
  if (c.req.query("revoke") === "1") {
    try {
      await new LangQuestClient(row.api_base, await getLangQuestToken(c.env, row)).revoke()
      revoked = true
    } catch (err) {
      console.warn("[langquest] revoke on disconnect failed:", err)
    }
  }
  await c.env.AQUILLA_PG.prepare("DELETE FROM langquest_connections WHERE id = ?").bind(row.id).run()
  return c.json({ ok: true, revoked })
})

export default connections
