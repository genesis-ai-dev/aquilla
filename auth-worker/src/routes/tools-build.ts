// POST /api/v2/projects/:projectId/tools/build — one builder attempt.
//
// Body: { request: string, repair?: { previousSource, previousManifest, failure }, attempt?: number,
//         base?: { source, manifest } }   — base present = edit_tool (change an existing tool)
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
  const attempt = typeof body?.attempt === "number" ? body.attempt : 0
  if (attempt > MAX_REPAIR_ATTEMPTS) {
    return c.json({ error: { code: "validation_failed", message: `at most ${MAX_REPAIR_ATTEMPTS} repair attempts` } }, 400)
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
    const result = await runBuild(c.env, { request, ...(repair ? { repair } : {}), ...(base ? { base } : {}) })
    console.log(
      `[tools/build] project=${projectId} attempt=${attempt} ok=${result.ok} model=${result.model} ` +
        `in=${result.usage.promptTokens} out=${result.usage.completionTokens} cost=$${result.usage.cost.toFixed(4)}`,
    )
    return c.json(result)
  } catch (e) {
    console.error("[tools/build] upstream failed:", e)
    return c.json({ error: { code: "upstream_failed", message: "the builder model call failed" } }, 502)
  }
}
