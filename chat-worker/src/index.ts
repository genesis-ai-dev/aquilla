// codex-chat-worker — authenticated proxy to OpenRouter for codex-web.
//
// Hosts the single route the codex-web frontend needs:
//   POST /api/v1/chat/completions
// Mounted under /api/v1/ to match the path the frontend already targets
// (see src/lib/completion/completion-service.ts:FRONTIER_CHAT_URL).
//
// Replaces the legacy frontier-server's `/api/v1/chat/completions` for
// codex-web traffic; codex-editor users keep hitting the old server. Once
// codex-editor traffic stops, the old route can be retired and SECRET_KEY
// rotated to fully decouple this worker from frontier-server.

import { Hono } from "hono"
import type { Env, Variables } from "./types"
import chatRoutes from "./routes/chat"

type HonoEnv = { Bindings: Env; Variables: Variables }

const app = new Hono<HonoEnv>()

// CORS for browser callers. The frontend sends Authorization as a Bearer
// header, never cookies, so `Access-Control-Allow-Origin: *` is safe and
// avoids hard-coding preview / prod / local origins.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
    name: "codex-chat-worker",
    routes: ["/api/v1/chat/completions"],
  }),
)

app.get("/healthz", (c) => c.json({ ok: true }))

app.route("/api/v1/chat", chatRoutes)

app.notFound((c) => c.json({ error: "Not found" }, 404))

app.onError((err, c) => {
  console.error("Unhandled error in chat-worker:", err)
  return c.json({ error: "Internal server error" }, 500)
})

export default app
