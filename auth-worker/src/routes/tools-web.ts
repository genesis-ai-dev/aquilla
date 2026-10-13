// POST /api/v2/projects/:projectId/tools/:toolId/web-fetch — aquilla.web.fetch.
//
// Body: { url: string, as?: "text" | "json" }
// → 200 { status, contentType, body, url }   (status = the SITE's status; 4xx/5xx bodies included)
//
// Who may: a project member whose standing grant for THIS tool includes
// read:web, for a URL on the tool's current manifest.web (and the optional
// TOOLS_WEB_ALLOWED_DOMAINS). Every other check lives in lib/tools/web-fetch.ts.
// Each call is rate-limited per user and written to the audit log line below.

import type { Context } from "hono"
import type { AuthHonoEnv } from "../middleware/auth"
import { resolveProjectRole } from "../services/project-permissions"
import { getTool } from "../lib/tools/store"
import { WebFetchError, WEB_FETCH_MAX_PER_WINDOW, deploymentAllowlist, dohResolver, proxyWebFetch } from "../lib/tools/web-fetch"
import { countRecentEvents, recordAuthEvent, userIdentifier } from "../utils/rate-limit"

type Ctx = Context<AuthHonoEnv>

function fail(c: Ctx, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as 400)
}

export async function webFetchRoute(c: Ctx) {
  const projectId = c.req.param("projectId") ?? ""
  const toolId = c.req.param("toolId") ?? ""
  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return fail(c, 404, "not_found", "project not found")
  const tool = await getTool(c.env.AQUILLA_PG, projectId, toolId, user.id)
  if (!tool) return fail(c, 404, "not_found", "tool not found")
  const domains = tool.manifest.web ?? []
  if (!tool.manifest.scopes.includes("read:web") || domains.length === 0) return fail(c, 403, "permission_denied", "this extension does not declare read:web")
  if (!tool.grantedScopes.includes("read:web")) return fail(c, 403, "permission_denied", "you have not allowed this extension to read websites")

  const body = (await c.req.json().catch(() => null)) as { url?: unknown; as?: unknown } | null
  if (!body || typeof body.url !== "string" || !body.url.trim() || body.url.length > 2048) return fail(c, 400, "validation_failed", "url is required (at most 2048 characters)")
  const as = body.as === "json" ? "json" : "text"

  const ident = userIdentifier(user.id)
  if ((await countRecentEvents(c.env.AQUILLA_PG, "tool_web_fetch", ident, { onlyFailures: false })) >= WEB_FETCH_MAX_PER_WINDOW) {
    return fail(c, 429, "rate_limited", "too many website reads; try again in a few minutes")
  }
  await recordAuthEvent(c.env.AQUILLA_PG, "tool_web_fetch", ident, true)

  let host = ""
  try {
    host = new URL(body.url).hostname
  } catch {
    /* reported by proxyWebFetch */
  }
  try {
    const out = await proxyWebFetch(
      { url: body.url.trim(), as, domains, deploymentAllow: deploymentAllowlist(c.env.TOOLS_WEB_ALLOWED_DOMAINS) },
      // Bound wrappers: workerd's global fetch throws "Illegal invocation" when called as a method of another object.
      { fetch: (input, init) => fetch(input, init), resolve: dohResolver((input, init) => fetch(input, init)) },
    )
    console.log(JSON.stringify({ audit: "tools.web_fetch", projectId, toolId, userId: user.id, host: new URL(out.url).hostname, status: out.status, bytes: out.bytes }))
    return c.json({ status: out.status, contentType: out.contentType, body: out.body, url: out.url })
  } catch (err) {
    if (err instanceof WebFetchError) {
      console.log(JSON.stringify({ audit: "tools.web_fetch", projectId, toolId, userId: user.id, host, refused: err.code }))
      return fail(c, err.status, err.code, err.message)
    }
    console.error("[tools/web-fetch] failed:", err)
    return fail(c, 502, "fetch_failed", "the site could not be reached")
  }
}
