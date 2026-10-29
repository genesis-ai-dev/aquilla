// aquilla-monitor — uptime checks with Discord alerts. See README.md.
//
//   scheduled (every minute)  probe each target, alert on up/down changes
//   GET  /status              current state of every target (JSON)
//   GET  /health              liveness of this Worker
//   POST /test-alert          send a sample alert (Bearer MONITOR_ADMIN_TOKEN)

import { readConfig, type MonitorEnv } from "./config"
import { buildMessage, sendDiscord } from "./discord"
import { MonitorState } from "./state-do"
import { runTick } from "./tick"

export { MonitorState }

interface Env extends MonitorEnv {
  MONITOR_STATE: DurableObjectNamespace<MonitorState>
  DISCORD_WEBHOOK_URL?: string
  HEARTBEAT_URL?: string
  MONITOR_ADMIN_TOKEN?: string
}

const stateStub = (env: Env) => env.MONITOR_STATE.get(env.MONITOR_STATE.idFromName("singleton"))

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })

/** Constant-time compare so the admin token cannot be guessed byte by byte. */
function tokenMatches(header: string | null, expected: string): boolean {
  const given = new TextEncoder().encode(header?.replace(/^Bearer /, "") ?? "")
  const want = new TextEncoder().encode(expected)
  if (given.byteLength !== want.byteLength) return false
  return crypto.subtle.timingSafeEqual(given, want)
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const config = readConfig(env)
    const stub = stateStub(env)
    const events = await runTick(config, {
      fetch: (input, init) => fetch(input, init),
      now: Date.now,
      record: (results, thresholds, now) => stub.record(results, thresholds, now),
      discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
      heartbeatUrl: env.HEARTBEAT_URL,
    })
    if (events.length > 0) {
      console.log("[monitor] alerts", events.map((e) => `${e.kind}:${e.targetId}`).join(", "))
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (request.method === "GET" && pathname === "/health") return json({ ok: true, name: "aquilla-monitor" })

    if (request.method === "GET" && pathname === "/status") {
      const config = readConfig(env)
      const states = await stateStub(env).snapshot()
      return json({
        environment: config.environment,
        targets: config.targets.map((t) => ({ id: t.id, name: t.name, url: t.url, ...states[t.id] })),
      })
    }

    if (request.method === "POST" && pathname === "/test-alert") {
      // No token configured means the route does not exist: an open endpoint
      // would let anyone on the internet ping the team.
      if (!env.MONITOR_ADMIN_TOKEN) return new Response("Not found", { status: 404 })
      if (!tokenMatches(request.headers.get("Authorization"), env.MONITOR_ADMIN_TOKEN)) {
        return new Response("Unauthorized", { status: 401 })
      }
      if (!env.DISCORD_WEBHOOK_URL) return json({ ok: false, error: "DISCORD_WEBHOOK_URL is not set" }, 500)
      const config = readConfig(env)
      const now = Date.now()
      const message = buildMessage(
        [{ kind: "down", targetId: "test", at: now, downSince: now, error: "This is a test alert. Nothing is down.", latencyMs: 0 }],
        { ...config, targets: [{ id: "test", name: "Test alert", url: new URL("/status", request.url).toString() }] },
      )
      await sendDiscord(env.DISCORD_WEBHOOK_URL, message!)
      return json({ ok: true })
    }

    return new Response("Not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
