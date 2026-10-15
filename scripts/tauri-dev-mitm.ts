// `pnpm tauri:dev:mitm` — run the Tauri desktop app with every backend call
// routed through a local mitmproxy, so network faults can be injected against
// a running app. Change the fault with `pnpm mitm:mode <mode>`.
//
// Why reverse mode rather than a system proxy: WKWebView's networking lives in
// a separate process and ignores this process's env vars, so only macOS-wide
// proxy settings would reach it — machine-wide, and needing a trusted CA. But
// every host the app talks to comes from `VITE_AUTH_BASE` / `VITE_CHAT_BASE` /
// `VITE_SYNC_WORKER_HOST`, so pointing those at a local plain-HTTP reverse
// proxy captures the same traffic with no system settings and no CA.
//
// The Rust side comes along for free: `src/lib/offline/connectivity.ts` hands
// `AUTH_BASE` to `set_connectivity_probe_url`, so the connectivity loop probes
// the proxy too and the online/offline chip moves with the injected fault.
//
// Listener lifecycle lives here rather than in the addon. mitmproxy 12 relays
// reverse-proxied WebSocket connections raw — its `websocket_*` hooks never
// fire — and offers an addon no way to drop an established connection, so the
// only reliable way to kill a live sync socket is to stop the listener.
// Stopping it also makes new connections fail with ECONNREFUSED, which is a
// closer model of a vanished network than any per-flow fault. The addon
// handles only the listener-up faults (blackhole, error).
//
// Env overrides are passed to the child process rather than written to a file:
// Vite's `loadEnv` applies `process.env` last (after `.env.local` and
// `.env.development.local`), so this wins without touching the
// `.env.development.local` that `scripts/dev-stack.ts` manages.
//
// Flags:
//   --port <n>   first listener port (default 8081; +1 per distinct upstream)
//   --mode <m>   initial fault mode (default pass)
//   --no-app     run the fault proxy only, without launching Tauri. Prints the
//                env to export so you can point `pnpm dev:vite`, a browser, or
//                a manual client at it.
//
// Stop with Ctrl+C — mitmdump is killed and the state file removed.

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createConnection } from "node:net"
import { readFileSync, rmSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnv } from "vite"
import { planProxyTargets, mitmdumpModeArgs, type ProxyTarget } from "./lib/mitm-targets"
import {
  MITM_MODES,
  DEFAULT_MITM_STATE,
  wantsListenerDown,
  parseMitmState,
  writeMitmStateFile,
  type MitmMode,
  type MitmState,
} from "./lib/mitm-state"
import { killChildTree } from "./lib/spawn-worker"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ADDON = path.join(REPO_ROOT, "scripts", "mitm", "fault.py")
const STATE_FILE = path.join(REPO_ROOT, ".mitm-state.json")
const MITM_TAURI_CONFIG = "src-tauri/tauri.mitm.conf.json"
/** How often the supervisor re-reads the state file. */
const POLL_MS = 250

// ---------------------------------------------------------------------------
// Shutdown plumbing — mirrors scripts/dev-stack.ts
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void> | void> = []
let shuttingDown = false

async function shutdown(code = 0): Promise<never> {
  if (shuttingDown) process.exit(code)
  shuttingDown = true
  console.log("\n[mitm] shutting down…")
  for (const fn of [...cleanup].reverse()) {
    try {
      await fn()
    } catch (err) {
      console.error("[mitm] cleanup error:", err)
    }
  }
  process.exit(code)
}

// Ctrl+C signals the whole process group, so the tsx wrapper and this process
// can both deliver one. A repeat signal mid-cleanup must not cut it short and
// strand the state file — cleanup is already bounded by killChildTree's 5s.
function onSignal(code: number): void {
  if (shuttingDown) return
  void shutdown(code)
}

process.on("SIGINT", () => onSignal(130))
process.on("SIGTERM", () => onSignal(143))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

function requireMitmdump(): void {
  const found = spawnSync("mitmdump", ["--version"], { encoding: "utf8" })
  if (found.status === 0) {
    console.log(`[mitm] ${found.stdout.split("\n")[0]?.trim()}`)
    return
  }
  console.error(
    "[mitm] mitmdump not found on PATH.\n[mitm] Install it with: brew install mitmproxy",
  )
  process.exit(1)
}

/** Resolves once `port` accepts a connection, so the app never races the proxy. */
async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port })
      const done = (ok: boolean) => {
        socket.destroy()
        resolve(ok)
      }
      socket.once("connect", () => done(true))
      socket.once("error", () => done(false))
      socket.setTimeout(1_000, () => done(false))
    })
    if (open) return
    if (Date.now() > deadline) {
      throw new Error(`mitmproxy never started listening on 127.0.0.1:${port}`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * Reads the state file, falling back to `lastGood` when it is missing or
 * unreadable — a transient read failure must not be treated as a mode change.
 */
function readState(lastGood: MitmState): MitmState {
  if (!existsSync(STATE_FILE)) return lastGood
  try {
    return parseMitmState(readFileSync(STATE_FILE, "utf8"), lastGood)
  } catch {
    return lastGood
  }
}

// ---------------------------------------------------------------------------
// Listener supervisor — owns the mitmdump process
// ---------------------------------------------------------------------------

class Listener {
  private child: ChildProcess | null = null
  /** Children we stopped on purpose, so their exit isn't treated as a crash. */
  private readonly stopping = new WeakSet<ChildProcess>()
  private readonly targets: ProxyTarget[]

  constructor(targets: ProxyTarget[]) {
    this.targets = targets
  }

  get isUp(): boolean {
    return this.child !== null
  }

  async up(): Promise<void> {
    if (this.child) return
    const child = spawn(
      "mitmdump",
      [
        ...mitmdumpModeArgs(this.targets),
        "-s",
        ADDON,
        // Don't buffer large bodies (import blobs, audio) just to inspect them.
        "--set",
        "stream_large_bodies=1m",
        // One line per flow: enough to watch traffic move without burying the
        // addon's own fault log.
        "--set",
        "flow_detail=1",
      ],
      {
        cwd: REPO_ROOT,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, AQUILLA_MITM_STATE: STATE_FILE },
      },
    )
    this.child = child
    child.on("exit", (code) => {
      // A previous child's late exit must not clobber its replacement.
      if (this.child === child) this.child = null
      if (!this.stopping.has(child) && !shuttingDown) {
        console.error(`[mitm] mitmdump exited unexpectedly (code ${String(code)})`)
        void shutdown(1)
      }
    })
    for (const t of this.targets) await waitForPort(t.port)
  }

  /**
   * Stops the listener. Every connection through it dies, including the sync
   * WebSocket, and new ones get ECONNREFUSED — the disconnect we are modelling.
   */
  async down(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping.add(child)
    this.child = null
    await killChildTree(child)
  }
}

function describe(targets: ProxyTarget[], env: Record<string, string>): void {
  console.log("[mitm] routing through local listeners:")
  for (const t of targets) {
    console.log(`[mitm]   127.0.0.1:${t.port}  ->  ${t.upstream}   (${t.vars.join(", ")})`)
  }
  for (const [k, v] of Object.entries(env)) {
    console.log(`[mitm]   ${k}=${v}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  requireMitmdump()

  const portFlag = flagValue("--port")
  const basePort = Number(portFlag ?? 8081)
  if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65_535) {
    console.error(`[mitm] --port must be a valid port number, got: ${String(portFlag)}`)
    process.exit(1)
  }

  const initialMode = (flagValue("--mode") ?? "pass") as MitmMode
  if (!MITM_MODES.includes(initialMode)) {
    console.error(`[mitm] --mode must be one of: ${MITM_MODES.join(", ")}`)
    process.exit(1)
  }

  // Resolve the bases exactly as the app would: same loader, same mode, same
  // precedence across .env / .env.local / .env.development.local.
  const viteEnv = loadEnv("development", REPO_ROOT, "VITE_")

  let plan
  try {
    plan = planProxyTargets(viteEnv, basePort)
  } catch (err) {
    console.error(`[mitm] ${(err as Error).message}`)
    process.exit(1)
  }

  for (const warning of plan.warnings) console.warn(`[mitm] WARNING: ${warning}`)
  describe(plan.targets, plan.env)

  writeMitmStateFile(STATE_FILE, { ...DEFAULT_MITM_STATE, mode: initialMode })
  cleanup.push(() => rmSync(STATE_FILE, { force: true }))

  const listener = new Listener(plan.targets)
  cleanup.push(() => listener.down())
  await listener.up()
  console.log(`[mitm] proxy up — fault mode: ${initialMode}`)
  console.log(`[mitm] change it with: pnpm mitm:mode <${MITM_MODES.join("|")}>`)

  // Supervisor: the only thing that decides whether the listener is up.
  let lastGood: MitmState = { ...DEFAULT_MITM_STATE, mode: initialMode }
  let lastMode: MitmMode | null = null
  let flapSince = Date.now()
  // Ticks must not overlap: up()/down() take seconds (port wait, graceful
  // kill), and a tick that sees the listener "down" while the old mitmdump is
  // still exiting would spawn a replacement that races it for the port.
  let ticking = false
  const poll = setInterval(() => {
    if (ticking) return
    ticking = true
    void (async () => {
      const state = readState(lastGood)
      lastGood = state
      if (state.mode !== lastMode) {
        if (state.mode === "flap") flapSince = Date.now()
        lastMode = state.mode
        console.log(`[mitm] mode -> ${state.mode}`)
      }
      const half = Math.max(state.periodSeconds, 1) * 1000
      const flapPhaseDown = Math.floor((Date.now() - flapSince) / half) % 2 === 1
      const shouldBeDown = wantsListenerDown(state.mode, flapPhaseDown)

      if (shouldBeDown && listener.isUp) {
        console.log("[mitm] listener DOWN — live sockets dropped, new connections refused")
        await listener.down()
      } else if (!shouldBeDown && !listener.isUp) {
        await listener.up()
        console.log("[mitm] listener UP — traffic forwarding again")
      }
    })()
      .catch((err: unknown) => console.error("[mitm] supervisor error:", err))
      .finally(() => {
        ticking = false
      })
  }, POLL_MS)
  cleanup.push(() => clearInterval(poll))

  if (process.argv.includes("--no-app")) {
    console.log("[mitm] --no-app: not launching Tauri. Point a client at:")
    for (const [k, v] of Object.entries(plan.env)) console.log(`[mitm]   export ${k}=${v}`)
    return
  }

  // The shipped CSP allows only https:/wss: for backend calls, which would
  // block the plain-HTTP loopback proxy. The overlay widens connect-src for
  // this run only — `tauri:build` never sees it, so the release CSP stands.
  const app: ChildProcess = spawn("pnpm", ["tauri", "dev", "--config", MITM_TAURI_CONFIG], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...plan.env },
  })
  cleanup.push(() => killChildTree(app))
  app.on("exit", (code) => {
    if (!shuttingDown) void shutdown(code ?? 0)
  })
}

void main().catch((err: unknown) => {
  console.error("[mitm]", err)
  void shutdown(1)
})
