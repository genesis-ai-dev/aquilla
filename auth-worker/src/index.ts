// codex-auth-worker — side-by-side identity worker for the codex-web frontend.
//
// Mounts auth + sync-token + project-invite routes under /api/v2/. Same
// frontier-db-v2 as the legacy frontier-server (shared SECRET_KEY) so a user
// registered here can log in via the old codex-editor and vice versa.
//
// Routes:
//   POST /api/v2/auth/register
//   POST /api/v2/auth/token
//   GET  /api/v2/auth/me
//   GET  /api/v2/auth/gitlab/info
//   GET  /api/v2/auth/gitlab/projects/count
//   GET  /api/v2/auth/activity-log
//   POST /api/v2/auth/password-reset/request
//   POST /api/v2/auth/password-reset/verify
//   POST /api/v2/auth/password-reset/reset
//   POST /api/v2/sync-token
//   POST /api/v2/projects/:projectId/invites
//   GET  /api/v2/projects/invite-preview/:token
//   POST /api/v2/projects/accept-invite

import { Hono } from "hono"
import type { Env, Variables } from "./types"
import authRoutes from "./routes/auth"
import syncTokenRoutes from "./routes/sync-token"
import projectsInvitesRoutes from "./routes/projects-invites"

type HonoEnv = { Bindings: Env; Variables: Variables }

const app = new Hono<HonoEnv>()

// CORS for browser callers. The frontend sends Authorization as a Bearer
// header, never cookies, so `Access-Control-Allow-Origin: *` is safe and
// avoids hard-coding preview / prod / local origins.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
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
      "/api/v2/projects/*",
    ],
  }),
)

app.get("/healthz", (c) => c.json({ ok: true }))

app.route("/api/v2/auth", authRoutes)
app.route("/api/v2/sync-token", syncTokenRoutes)
app.route("/api/v2/projects", projectsInvitesRoutes)

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
