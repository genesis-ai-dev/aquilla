// aquilla-identity (Phase D) — full identity worker for the codex-web frontend.
//
// Promoted from stub auth surface to the complete identity + project surface.
// Legacy frontier-server is no longer part of the codex-web runtime.
//
// Routes:
//   POST /api/v2/auth/register
//   POST /api/v2/auth/token
//   GET  /api/v2/auth/me
//   GET  /api/v2/auth/activity-log
//   POST /api/v2/auth/password-reset/request
//   POST /api/v2/auth/password-reset/verify
//   POST /api/v2/auth/password-reset/reset
//   POST /api/v2/sync-token
//   GET  /api/v2/users/lookup
//   GET  /api/v2/users/search
//   GET  /api/v2/orgs/me
//   GET  /api/v2/orgs/:orgId/members
//   POST /api/v2/orgs/:orgId/members
//   DELETE /api/v2/orgs/:orgId/members/:userId
//   GET  /api/v2/orgs/:orgId/members/:userId/projects
//   GET  /api/v2/orgs/:orgId/invites
//   POST /api/v2/projects
//   GET  /api/v2/projects
//   GET  /api/v2/projects/:projectId
//   POST /api/v2/projects/:projectId/archive
//   DELETE /api/v2/projects/:projectId/archive
//   GET  /api/v2/projects/:projectId/members
//   POST /api/v2/projects/:projectId/members
//   DELETE /api/v2/projects/:projectId/members/:userId
//   DELETE /api/v2/projects/:projectId/files/:fileId
//   POST /api/v2/projects/:projectId/invites
//   GET  /api/v2/projects/invite-preview/:token
//   POST /api/v2/projects/accept-invite
//   DELETE /api/v2/projects/:projectId/invites/:token
//   GET  /api/v2/projects/:projectId/settings
//   PUT  /api/v2/projects/:projectId/settings
//   POST /api/v2/projects/:projectId/link-source
//   POST /api/v2/projects/:projectId/detach-source
//   GET  /api/v2/projects/:projectId/downstreams
//   DELETE /api/v2/projects/:projectId
//   POST /api/v2/invites/multi
//   GET  /api/v2/invites/:token/preview
//   POST /api/v2/invites/:token/accept
//   GET  /api/v2/health
//   POST /__test__/reset (WRANGLER_LOCAL only)

import { Hono } from "hono"
import type { Env, Variables } from "./types"
import authRoutes from "./routes/auth"
import syncTokenRoutes from "./routes/sync-token"
import projectsRoutes from "./routes/projects"
import projectSettingsRoutes from "./routes/project-settings"
import sourceLinkingRoutes from "./routes/source-linking"
import invitesRoutes from "./routes/invites"
import orgsRoutes from "./routes/orgs"
import usersRoutes from "./routes/users"
import testResetRoutes from "./routes/test-reset"

type HonoEnv = { Bindings: Env; Variables: Variables }

const app = new Hono<HonoEnv>()

// CORS for browser callers. The frontend sends Authorization as a Bearer
// header, never cookies, so `Access-Control-Allow-Origin: *` is safe and
// avoids hard-coding preview / prod / local origins.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match-Version",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
}

// Workers Routes mount: if a zone routes `aquilla.app/api/identity/*` to this
// worker, strip the prefix so bare /api/v2/... paths work unchanged.
app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/identity")) {
    const url = new URL(c.req.url)
    url.pathname = url.pathname.slice("/api/identity".length) || "/"
    return app.fetch(new Request(url.toString(), c.req.raw), c.env, c.executionCtx)
  }
  return next()
})

app.options("*", () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
})

app.use("*", async (c, next) => {
  await next()
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    c.res.headers.set(k, v)
  }
})

app.get("/", (c) =>
  c.json({
    name: "aquilla-identity",
    routes: [
      "/api/v2/auth/*",
      "/api/v2/sync-token",
      "/api/v2/users/*",
      "/api/v2/orgs/*",
      "/api/v2/projects/*",
      "/api/v2/invites/*",
      "/api/v2/health",
    ],
  }),
)

app.get("/healthz", (c) => c.json({ ok: true }))

// Liveness probe for the frontend (replaces the old api.frontierrnd.com
// /api/v2/health that the AI controls used to gate on).
app.get("/api/v2/health", (c) => c.json({ ok: true, name: "aquilla-identity" }))

app.route("/api/v2/auth", authRoutes)
app.route("/api/v2/sync-token", syncTokenRoutes)
app.route("/api/v2/users", usersRoutes)
app.route("/api/v2/orgs", orgsRoutes)
// Project-settings + source-linking surfaces are mounted as siblings to
// the main projects router so they live in their own files without colliding.
app.route("/api/v2/projects", projectSettingsRoutes)
app.route("/api/v2/projects", sourceLinkingRoutes)
app.route("/api/v2/projects", projectsRoutes)
// Multi-project invite surface.
app.route("/api/v2/invites", invitesRoutes)

// Test-only reset endpoint (WRANGLER_LOCAL only — see routes/test-reset.ts).
app.route("/__test__", testResetRoutes)

app.notFound((c) => c.json({ error: "Not found" }, 404))

app.onError((err, c) => {
  console.error("Unhandled error in auth-worker:", err)
  return c.json({ error: "Internal server error" }, 500)
})

export default app
