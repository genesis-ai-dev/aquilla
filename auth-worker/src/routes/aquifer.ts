// Bible Aquifer read-only proxy + publish endpoint (bibletranslation.org).
//
// Mounted at /api/v1/aquifer in src/index.ts. Backs the Search-dock
// "Bible resources" mode and the agent's aquifer_publish proposal Apply path.
//
//   GET  /search?projectId=&q=&lang=&limit=   any project member, gated
//   GET  /page?projectId=&path=&maxChars=     any project member, gated
//   POST /answers  { projectId, question, answer, status, citations }  gated
//   GET  /tabitha?projectId=&book=&chapter=&verse=   any project member, gated
//        TaBiThA Copilot translator brief for one verse (Verse Resources panel);
//        see lib/tabitha/client.ts.
//
// All four:
//   * require auth + any role on the project (the agent and UI are project-scoped),
//   * 404 when project_settings.bibleResourcesEnabled is not true (the feature
//     "simply isn't there" when off),
//   * consume NO credits — these are plain reference reads / an external write,
//     not LLM calls. The credit ledger is deliberately untouched here.
//
// Design: docs/superpowers/specs/2026-06-13-aquifer-integration-design.md.

import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { enforceRateLimit, userRateLimitIdentifier } from "../../../db/shared/rate-limit"
import { resolveProjectRole } from "../services/project-permissions"
import { isBibleResourcesEnabled } from "../lib/aquifer/gate"
import {
  aquiferSearch,
  aquiferReadPage,
  aquiferPublishAnswer,
  type AquiferPublishPayload,
} from "../lib/aquifer/client"
import { tabithaVerseBrief } from "../lib/tabitha/client"

const aquifer = new Hono<AuthHonoEnv>()

/** Shared guard: member access + feature gate. Returns null when allowed,
 *  or a Response to short-circuit when not. */
// Pen-test 2026-10-15: these routes fan out to third-party hosts (and
// POST /answers publishes publicly) but had no per-user throttle.
async function throttle(
  c: Context<AuthHonoEnv>,
  kind: string,
  limit: number,
  failMode: "open" | "closed",
): Promise<Response | null> {
  const r = await enforceRateLimit(c.env.AQUILLA_PG, {
    kind,
    identifier: userRateLimitIdentifier(c.get("user").id),
    limit,
    failMode,
  })
  if (r.allowed) return null
  return c.json(
    { error: "Too many requests. Try again shortly." },
    429,
    { "Retry-After": String(r.retryAfterSeconds) },
  )
}

async function guard(c: Context<AuthHonoEnv>, projectId: string): Promise<Response | null> {
  const user = c.get("user")
  if (!projectId) return c.json({ error: "projectId required" }, 400)
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)
  if (!(await isBibleResourcesEnabled(c.env, projectId))) {
    // Off → behave as if the feature doesn't exist for this project.
    return c.json({ error: "bible resources not enabled for this project" }, 404)
  }
  return null
}

// ── GET /search ─────────────────────────────────────────────────────────────
aquifer.get("/search", authMiddleware, async (c) => {
  const projectId = c.req.query("projectId") ?? ""
  const blocked = await guard(c, projectId)
  if (blocked) return blocked
  const throttled = await throttle(c, "aquifer_read", 300, "open")
  if (throttled) return throttled

  const q = c.req.query("q") ?? ""
  if (!q.trim()) return c.json({ error: "q required" }, 400)
  const lang = c.req.query("lang") || "en"
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "", 10)
  const limit = Number.isFinite(limitRaw) ? limitRaw : undefined

  const res = await aquiferSearch(c.env, q, { lang, limit })
  if (!res.ok) return c.json({ error: res.error }, 502)
  return c.json(res.data)
})

// ── GET /page ─────────────────────────────────────────────────────────────
aquifer.get("/page", authMiddleware, async (c) => {
  const projectId = c.req.query("projectId") ?? ""
  const blocked = await guard(c, projectId)
  if (blocked) return blocked
  const throttled = await throttle(c, "aquifer_read", 300, "open")
  if (throttled) return throttled

  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ error: "path required" }, 400)
  const maxCharsRaw = Number.parseInt(c.req.query("maxChars") ?? "", 10)
  const maxChars = Number.isFinite(maxCharsRaw) ? maxCharsRaw : undefined

  const res = await aquiferReadPage(c.env, path, { maxChars })
  if (!res.ok) return c.json({ error: res.error }, 502)
  return c.json(res.data)
})

// ── GET /tabitha ────────────────────────────────────────────────────────────
aquifer.get("/tabitha", authMiddleware, async (c) => {
  const projectId = c.req.query("projectId") ?? ""
  const blocked = await guard(c, projectId)
  if (blocked) return blocked
  const throttled = await throttle(c, "aquifer_read", 300, "open")
  if (throttled) return throttled

  const book = c.req.query("book") ?? ""
  const chapter = Number(c.req.query("chapter"))
  const verse = Number(c.req.query("verse"))
  const res = await tabithaVerseBrief(book, chapter, verse)
  if (!res.ok) {
    return c.json({ error: res.error }, res.error === "unsupported reference" ? 400 : 502)
  }
  return c.json(res.data)
})

// ── POST /answers ───────────────────────────────────────────────────────────
const citationSchema = z.object({
  // http(s) only: citations are published to a public third-party site, and
  // z.string().url() alone accepts javascript:/data: schemes.
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "citation url must be http(s)"),
  title: z.string().optional(),
  quote: z.string().optional(),
})
const publishSchema = z.object({
  projectId: z.string().min(1),
  question: z.string().min(8).max(500),
  answer: z.string().min(20).max(8000),
  status: z.enum(["answered", "undetermined"]).default("answered"),
  citations: z.array(citationSchema).min(1),
  lang: z.string().optional(),
  agent: z.object({ name: z.string().optional(), model: z.string().optional() }).optional(),
})

aquifer.post("/answers", authMiddleware, zValidator("json", publishSchema), async (c) => {
  const body = c.req.valid("json")
  const blocked = await guard(c, body.projectId)
  if (blocked) return blocked
  // Publishes to a public third-party site: fail closed, tight cap.
  const throttled = await throttle(c, "aquifer_publish", 20, "closed")
  if (throttled) return throttled

  const payload: AquiferPublishPayload = {
    question: body.question,
    answer: body.answer,
    status: body.status,
    citations: body.citations,
    ...(body.lang ? { lang: body.lang } : {}),
    ...(body.agent ? { agent: body.agent } : {}),
  }
  const res = await aquiferPublishAnswer(c.env, payload)
  if (!res.ok) return c.json({ error: res.error }, 502)
  return c.json(res.data)
})

export default aquifer
