// `pnpm mitm:mode <mode>` — flip the network fault applied by the mitmproxy
// fronting `pnpm tauri:dev:mitm`, against the running app.
//
// Writes the JSON state file that `scripts/mitm/fault.py` polls. Deliberately
// decoupled from the proxy process so you can change the app's network
// conditions mid-session without restarting anything — restarting the proxy
// would reset the very outbox/reconnect state you are trying to watch.

import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  MITM_MODES,
  type MitmMode,
  DEFAULT_MITM_STATE,
  writeMitmStateFile,
  resolveMitmStateFile,
} from "./lib/mitm-state"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const STATE_FILE = resolveMitmStateFile(REPO_ROOT)

const USAGE = `Usage: pnpm mitm:mode <mode> [options]

Modes:
  pass        forward everything untouched (the "back online" switch)
  offline     stop the listener — drops the live sync WebSocket and refuses
              every new connection. The closest model of a vanished network.
  blackhole   hold requests open, never answer — the captive-portal hang
  error       answer with an HTTP status (default 503)
  flap        alternate offline/pass on a timer

Options:
  --status <n>   status code for 'error' mode (default 503)
  --stall <s>    seconds to hold a request in 'blackhole' mode (default 600)
  --period <s>   half-period in seconds for 'flap' mode (default 20)

With no arguments, prints the current mode.

Notes:
  'error' does NOT flip the connectivity chip offline — the Rust probe in
  src-tauri/src/connectivity.rs treats any response that arrives as reachable.
  Use 'offline' or 'blackhole' to take the chip offline.

  'blackhole' only stalls HTTP. A sync WebSocket that is already open keeps
  streaming, because mitmproxy relays reverse-proxied WebSockets raw. Use
  'offline' when the socket itself must die.`

function readState(): Record<string, unknown> {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_MITM_STATE }
  try {
    const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { ...DEFAULT_MITM_STATE }
  } catch {
    return { ...DEFAULT_MITM_STATE }
  }
}

function numericFlag(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag)
  if (i === -1) return undefined
  const value = Number(args[i + 1])
  if (!Number.isFinite(value)) {
    console.error(`[mitm] ${flag} needs a number`)
    process.exit(1)
  }
  return value
}

function main(): void {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    const state = readState()
    console.log(`[mitm] current mode: ${String(state.mode ?? "pass")}`)
    console.log(`[mitm] state file:   ${path.relative(REPO_ROOT, STATE_FILE)}`)
    if (!existsSync(STATE_FILE)) {
      console.log("[mitm] (no state file — is `pnpm tauri:dev:mitm` running?)")
    }
    return
  }

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE)
    return
  }

  const mode = args[0] as MitmMode
  if (!MITM_MODES.includes(mode)) {
    console.error(`[mitm] unknown mode: ${args[0]}\n`)
    console.error(USAGE)
    process.exit(1)
  }

  // Preserve the other knobs so setting a mode doesn't silently reset the
  // stall/period you configured earlier in the session.
  const next: Record<string, unknown> = { ...readState(), mode }
  const status = numericFlag(args, "--status")
  const stall = numericFlag(args, "--stall")
  const period = numericFlag(args, "--period")
  if (status !== undefined) next.status = status
  if (stall !== undefined) next.stallSeconds = stall
  if (period !== undefined) next.periodSeconds = period

  // Atomic: the supervisor and fault.py poll this file, and a truncated read
  // mid-write must never look like a mode change.
  writeMitmStateFile(STATE_FILE, next)

  const detail =
    mode === "error"
      ? ` (status ${String(next.status)})`
      : mode === "blackhole"
        ? ` (holding ${String(next.stallSeconds)}s)`
        : mode === "flap"
          ? ` (${String(next.periodSeconds)}s half-period)`
          : ""
  console.log(`[mitm] mode -> ${mode}${detail}`)
  if (mode === "error") {
    console.log(
      "[mitm] note: the connectivity chip stays 'online' in this mode — see `pnpm mitm:mode --help`.",
    )
  }
  if (mode === "flap" && Number(next.periodSeconds) < 5) {
    // Coming back up means respawning mitmdump and waiting for the port, which
    // costs a second or two. Below ~5s the "up" phase is mostly that startup
    // and the app sees a near-permanent outage instead of a flapping one.
    console.warn(
      `[mitm] WARNING: a ${String(next.periodSeconds)}s half-period is shorter than the ~1-2s listener restart — ` +
        "the up phase will be mostly startup. Use --period 5 or more.",
    )
  }
  if (mode === "blackhole") {
    console.log(
      "[mitm] note: stalls HTTP only — an already-open sync WebSocket keeps streaming. Use 'offline' to kill it.",
    )
  }
}

main()
