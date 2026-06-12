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
//   POST /api/v2/projects/:projectId/members/:userId/revoke-all
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
//   GET  /api/v2/admin/me          (PLATFORM_ADMINS only)
//   GET  /api/v2/admin/overview    (PLATFORM_ADMINS only)
//   GET  /api/v2/admin/orgs        (PLATFORM_ADMINS only)
//   GET  /api/v2/admin/users       (PLATFORM_ADMINS only)
//   GET  /api/v2/admin/projects    (PLATFORM_ADMINS only)
//   GET  /api/v2/admin/activity    (PLATFORM_ADMINS only)
//   GET  /api/v2/health
//   POST /__test__/reset (WRANGLER_LOCAL only)
//   POST /__dev__/seed   (WRANGLER_LOCAL only)
//   POST /__dev__/login  (WRANGLER_LOCAL only)

import { Hono } from "hono"
import type { Env, Variables } from "./types"
import authRoutes from "./routes/auth"
import syncTokenRoutes from "./routes/sync-token"
import projectsRoutes from "./routes/projects"
import projectMembersRoutes from "./routes/project-members"
import projectSettingsRoutes from "./routes/project-settings"
import orgSettingsRoutes from "./routes/org-settings"
import sourceLinkingRoutes from "./routes/source-linking"
import invitesRoutes from "./routes/invites"
import orgsRoutes from "./routes/orgs"
import usersRoutes from "./routes/users"
import adminRoutes from "./routes/admin"
import testResetRoutes from "./routes/test-reset"
import devSeedRoutes from "./routes/dev-seed"
import chatRoutes from "./routes/chat"
import agentRoutes from "./routes/agent"
import parseDocumentRoutes from "./routes/parse-document"
import termbaseSubscriptionRoutes from "./routes/termbase-subscriptions"

type HonoEnv = { Bindings: Env; Variables: Variables }

import { makePostgres } from "../../db/shim/postgres"

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

// Workers Routes mount: this worker is routed under two prefixes on the
// api.aquilla.app subdomain — `/identity/*` for the identity surface
// (v1/v2 auth, orgs, projects, invites…) and `/chat/*` for the OpenRouter
// proxy (folded in from the former aquilla-chat-worker, 2026-05-26). Strip
// whichever prefix matched so the bare `/api/v1/…` / `/api/v2/…` paths
// declared on the routers work unchanged. Pre-migration these were
// `/api/identity` and `/api/chat` under the aquilla.app apex.
app.use("*", async (c, next) => {
  for (const prefix of ["/identity", "/chat"]) {
    if (c.req.path.startsWith(prefix)) {
      const url = new URL(c.req.url)
      url.pathname = url.pathname.slice(prefix.length) || "/"
      return app.fetch(new Request(url.toString(), c.req.raw), c.env, c.executionCtx)
    }
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
      "/api/v2/admin/*",
      "/api/v2/health",
      "/api/v1/chat/completions",
      "/api/v1/ai/agent/run",
    ],
  }),
)

app.get("/healthz", (c) => c.json({ ok: true }))

// Liveness probe for the frontend (replaces the old api.frontierrnd.com
// /api/v2/health that the AI controls used to gate on).
app.get("/api/v2/health", (c) => c.json({ ok: true, name: "aquilla-identity" }))

app.route("/api/v2/auth", authRoutes)
// Legacy alias: old clients (and frontier-server-era tokens) still hit
// /api/v1/auth/* — keep the auth surface mounted there too.
app.route("/api/v1/auth", authRoutes)
app.route("/api/v2/sync-token", syncTokenRoutes)
app.route("/api/v2/users", usersRoutes)
app.route("/api/v2/orgs", orgSettingsRoutes)
// Org termbase publish/subscribe (migration 0030). Mounted under BOTH prefixes
// — /orgs/:orgId/published-termbases lives here, the rest under /projects/:id/
// termbase/*. The two path-spaces are disjoint so one router serves both.
app.route("/api/v2/orgs", termbaseSubscriptionRoutes)
app.route("/api/v2/orgs", orgsRoutes)
// Platform-operator (site-wide admin) surface — read-only, cross-tenant.
// Gated by PLATFORM_ADMINS allowlist via requirePlatformAdmin (see
// routes/admin.ts); no-op for everyone not on the list.
app.route("/api/v2/admin", adminRoutes)
// Project-settings + source-linking surfaces are mounted as siblings to
// the main projects router so they live in their own files without colliding.
// FRO-180: project-members revoke-all endpoint (new file, doesn't touch projects.ts).
app.route("/api/v2/projects", projectMembersRoutes)
app.route("/api/v2/projects", projectSettingsRoutes)
app.route("/api/v2/projects", sourceLinkingRoutes)
app.route("/api/v2/projects", termbaseSubscriptionRoutes)
app.route("/api/v2/projects", projectsRoutes)
// Multi-project invite surface.
app.route("/api/v2/invites", invitesRoutes)

// Chat-completion proxy to OpenRouter (formerly aquilla-chat-worker). The
// path is kept at /api/v1/chat/completions so the codex-web client doesn't
// need to change — it just points VITE_CHAT_BASE at api.aquilla.app/chat.
app.route("/api/v1/chat", chatRoutes)
// Translation agent (SSE) — one-tool SQL agent, staged-write proposals.
// Same auth + AI-guard path as chat; see routes/agent.ts and the 2026-06-12
// translation-agent design/implementation-plan specs.
app.route("/api/v1/ai/agent", agentRoutes)
app.route("/api/v2/parse-document", parseDocumentRoutes)

// Test-only reset endpoint (WRANGLER_LOCAL only — see routes/test-reset.ts).
app.route("/__test__", testResetRoutes)
// Dev-only seed + login bypass (WRANGLER_LOCAL only — see routes/dev-seed.ts).
app.route("/__dev__", devSeedRoutes)

app.notFound((c) => c.json({ error: "Not found" }, 404))

app.onError((err, c) => {
  console.error("Unhandled error in auth-worker:", err)
  return c.json({ error: "Internal server error" }, 500)
})

// Postgres (Neon) is the only datastore. Serve AQUILLA_PG via the Postgres
// shim. The shim + its connection are created PER REQUEST and injected via a
// fresh env COPY ({ ...env, AQUILLA_PG: shim }) — never by mutating the shared
// isolate-wide `env`. Mutating it (the old middleware) let concurrent requests
// clobber each other's DB handle, causing "Cannot perform I/O on behalf of a
// different request" 500s under the assignments fan-out. Mirrors sync-worker.
//
// We wrap app.fetch (rather than exporting a separate object) so `export
// default app` and tests' `app.request(path, init, env)` keep working — Hono's
// app.request() routes through app.fetch.
//
// Pass-through (skip shim creation) when the datastore is already present as
// env.AQUILLA_PG: the re-entrant prefix-strip re-dispatch carries the shim with
// HYPERDRIVE dropped, and tests inject a PGlite handle the same way. A genuine
// first entry has neither — and then HYPERDRIVE is required, because the D1→Neon
// cutover removed D1 as a datastore (a missing binding is a config error, not a
// silent fallback to an empty local D1).
const baseFetch = app.fetch.bind(app)
app.fetch = (async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
  if (env?.AQUILLA_PG) return baseFetch(request, env, ctx)
  if (!env?.HYPERDRIVE) {
    return new Response(
      "HYPERDRIVE not bound — Postgres is required (D1 has been removed as a datastore)",
      { status: 500 },
    )
  }
  const shim = makePostgres(env.HYPERDRIVE.connectionString)
  // Drop HYPERDRIVE so the prefix-strip middleware's re-entrant app.fetch reuses
  // this shim (via reqEnv.AQUILLA_PG) instead of opening a second connection.
  // PG_CONNECTION_STRING: streaming routes (routes/agent.ts) must open their
  // own connection — the request-scoped shim below is closed as soon as the
  // Response returns, which is BEFORE an SSE stream body finishes.
  const reqEnv = {
    ...env,
    AQUILLA_PG: shim as unknown as AquillaDb,
    HYPERDRIVE: undefined,
    PG_CONNECTION_STRING: env.HYPERDRIVE.connectionString,
  }
  try {
    return await baseFetch(request, reqEnv, ctx)
  } finally {
    ctx.waitUntil(shim.close())
  }
}) as typeof app.fetch

export default app
