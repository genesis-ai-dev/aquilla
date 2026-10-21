// POST /api/v2/projects/:projectId/tools/build — one builder attempt.
//
// Body: { request: string, repair?: { previousSource, previousManifest, failure },
//         base?: { source, manifest } }   — base present = edit_tool (change an existing tool)
// A client `attempt` is ignored (AQU-2063): the server counts repairs itself.
// → 200 { ok:true, source, manifest, model, usage } | { ok:false, failure, source, manifestJson, lint, model, usage }
//
// Synchronous for the prototype (the SPA shows a progress card while it
// waits). Follow-up: run builds as background jobs with resumable progress.
// Like agent-worker's /exec, a multi-second response here is the contract.

import type { Context } from "hono"
import type { AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { MAX_REPAIR_ATTEMPTS, builderUpstream, runBuild } from "../lib/tools/builder"
import { admitLlmCall, LlmRefusedError, projectOrgId } from "../lib/billing/paid-llm"
import { enforceRateLimit } from "../../../db/shared/rate-limit"

/** Repairs of one request, counted on the server (spec §3.2 row 25). The key
 *  is the person, the project and the request text: the SPA resends that text
 *  unchanged with every repair of the same build. */
async function countRepair(c: Context<AuthHonoEnv>, projectId: string, request: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${projectId}\n${request}`))
  const key = Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")
  return enforceRateLimit(c.env.AQUILLA_PG, {
    kind: "tools_build_repair",
    identifier: `user:${c.get("user").id}:${key}`,
    limit: MAX_REPAIR_ATTEMPTS,
    // Each repair is a paid model call: an unavailable counter must not
    // become unlimited repairs.
    failMode: "closed",
  })
}

const MAX_REQUEST_CHARS = 4000

export async function buildToolRoute(c: Context<AuthHonoEnv>) {
  const projectId = c.req.param("projectId") ?? ""
  const role = await resolveProjectRole(c.env, c.get("user"), projectId)
  if (!role) return c.json({ error: { code: "not_found", message: "project not found" } }, 404)
  if (role.level < ROLE.CONTRIBUTOR) {
    return c.json({ error: { code: "permission_denied", message: "building a tool requires contributor access" } }, 403)
  }
  if (!builderUpstream(c.env).apiKey) {
    return c.json({ error: { code: "unavailable", message: "the tool builder is not configured (TOOLS_BUILDER_API_KEY / OPENROUTER_API_KEY)" } }, 503)
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  const request = typeof body?.request === "string" ? body.request.trim() : ""
  if (!request) return c.json({ error: { code: "validation_failed", message: "request is required" } }, 400)
  if (request.length > MAX_REQUEST_CHARS) {
    return c.json({ error: { code: "validation_failed", message: `request exceeds ${MAX_REQUEST_CHARS} characters` } }, 400)
  }
  const r = body?.repair
  let repair: { previousSource: string; previousManifest: string; failure: string } | undefined
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const rr = r as Record<string, unknown>
    if (typeof rr.failure === "string") {
      repair = {
        previousSource: typeof rr.previousSource === "string" ? rr.previousSource.slice(0, 250_000) : "",
        previousManifest: typeof rr.previousManifest === "string" ? rr.previousManifest.slice(0, 5000) : "{}",
        failure: rr.failure.slice(0, 5000),
      }
    }
  }

  let attempt = 0
  if (repair) {
    const counted = await countRepair(c, projectId, request)
    if (counted.degraded) {
      return c.json({ error: { code: "unavailable", message: "the repair counter is unavailable; try again shortly" } }, 503)
    }
    if (!counted.allowed) {
      return c.json({ error: { code: "validation_failed", message: `at most ${MAX_REPAIR_ATTEMPTS} repair attempts` } }, 400)
    }
    attempt = counted.hits
  }

  // AQU-2063: every builder call is admitted by the AI entitlement check and
  // settles its reported cost against the project's org, as this person.
  const scope = {
    orgId: await projectOrgId(c.env.AQUILLA_PG, projectId),
    userId: c.get("user").id,
    projectId,
    rail: "llm" as const,
  }
  const admit = (bound: Parameters<typeof admitLlmCall>[3]) => admitLlmCall(c.env.AQUILLA_PG, c.env, scope, bound)

  try {
    const b = body?.base
    let base: { source: string; manifest: string } | undefined
    if (b && typeof b === "object" && !Array.isArray(b)) {
      const bb = b as Record<string, unknown>
      if (typeof bb.source === "string") {
        base = {
          source: bb.source.slice(0, 250_000),
          manifest: typeof bb.manifest === "string" ? bb.manifest.slice(0, 5000) : JSON.stringify(bb.manifest ?? {}).slice(0, 5000),
        }
      }
    }
    const result = await runBuild(c.env, { request, ...(repair ? { repair } : {}), ...(base ? { base } : {}) }, { admit })
    console.log(
      `[tools/build] project=${projectId} attempt=${attempt} ok=${result.ok} model=${result.model} ` +
        `in=${result.usage.promptTokens} out=${result.usage.completionTokens} cost=$${result.usage.cost.toFixed(4)}`,
    )
    return c.json(result)
  } catch (e) {
    if (e instanceof LlmRefusedError) return c.json(e.refusal.body, e.refusal.status)
    console.error("[tools/build] upstream failed:", e)
    return c.json({ error: { code: "upstream_failed", message: "the builder model call failed" } }, 502)
  }
}
