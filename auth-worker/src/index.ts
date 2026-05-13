// codex-auth-worker — codex-web's identity + project surface backend.
//
// Side-by-side writer with the legacy frontier-server on the same
// frontier-db-v2 (shared SECRET_KEY) so a user registered here can log in
// via the old codex-editor and vice versa. As of 2026-05-13 this worker
// also owns the project / org / member / user-search surface that codex-web
// previously fetched from frontier-server; the old fork keeps serving the
// codex-editor VS Code extension at api.frontierrnd.com.
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
//   GET  /api/v2/projects/:projectId/settings              (Phase 1C)
//   PUT  /api/v2/projects/:projectId/settings              (Phase 1C)
//   POST /api/v2/projects/:projectId/link-source           (Phase 1C, AD-9)
//   POST /api/v2/projects/:projectId/detach-source         (Phase 1C, AD-9)
//   GET  /api/v2/projects/:projectId/downstreams           (Phase 1C, AD-9)
//   DELETE /api/v2/projects/:projectId                     (Phase 1C, blocked-if-downstreams)
//   POST /api/v2/invites/multi                             (Phase 1C, multi-project token)
//   GET  /api/v2/invites/:token/preview                    (Phase 1C, multi-project preview)
//   POST /api/v2/invites/:token/accept                     (Phase 1C, multi-project accept)
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
    name: "codex-auth-worker",
    routes: [
      "/api/v2/auth/*",
      "/api/v2/sync-token",
      "/api/v2/users/*",
      "/api/v2/orgs/*",
      "/api/v2/projects/*",
      "/api/v2/health",
    ],
  }),
)

app.get("/healthz", (c) => c.json({ ok: true }))

// Liveness probe for the frontend (replaces the old api.frontierrnd.com
// /api/v2/health that the AI controls used to gate on). Returns 200 + a
// small JSON body — clients only inspect `ok`.
app.get("/api/v2/health", (c) => c.json({ ok: true, name: "codex-auth-worker" }))

app.route("/api/v2/auth", authRoutes)
app.route("/api/v2/sync-token", syncTokenRoutes)
app.route("/api/v2/users", usersRoutes)
app.route("/api/v2/orgs", orgsRoutes)
// Project-settings + source-linking surfaces are mounted as siblings to
// the main projects router so Phase 1C lives in its own files. Hono dispatches
// by route shape, so mounting at the same base path is fine — the routers
// don't collide on any path. See routes/project-settings.ts and
// routes/source-linking.ts.
app.route("/api/v2/projects", projectSettingsRoutes)
app.route("/api/v2/projects", sourceLinkingRoutes)
app.route("/api/v2/projects", projectsRoutes)
// Multi-project invite surface. Single-project invite endpoints continue
// to live under /api/v2/projects via routes/projects.ts.
app.route("/api/v2/invites", invitesRoutes)

// Test-only reset endpoint. Mounted at the top level and gated by
// WRANGLER_LOCAL inside the handler — see routes/test-reset.ts.
app.route("/__test__", testResetRoutes)

// Legacy v1 alias — the codex-web frontend still calls /api/v1/auth/*
// (see src/lib/frontier/auth.ts). Mount the same router at v1 so we don't
// need a coordinated client+server cutover.
app.route("/api/v1/auth", authRoutes)

app.notFound((c) => c.json({ error: "Not found" }, 404))

app.onError((err, c) => {
  console.error("Unhandled error in auth-worker:", err)
  return c.json({ error: "Internal server error" }, 500)
})

export default app
