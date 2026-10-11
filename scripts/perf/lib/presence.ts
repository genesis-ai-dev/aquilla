/**
 * Multi-client presence load (AQU-1868): N real WebSockets into one project's
 * `ProjectSync` Durable Object, reporting per-socket frame rate and round-trip
 * latency.
 *
 * This is the shape the presence-tier tickets (AQU-1825 / AQU-1831) need a
 * before-and-after for: with one socket per contributor, every
 * `presence.update` fans out to every other socket, so the frame rate each
 * client has to absorb is what grows — not the latency of any single send.
 * Both numbers are reported; neither alone shows the cost.
 *
 * Latency uses the DO's own `ping`/`pong` echo (`sync-worker/src/project-do.ts`
 * answers `{t:"pong", ts}` with the ts it was given), so a measurement is a
 * genuine server round trip and not a local timer.
 */

import { summarize, type LatencySummary } from "./stats"
import { mintSyncToken, projectWsUrl, type PerfTarget } from "./client"

export interface PresenceLoadOptions {
  target: PerfTarget
  jwt: string
  projectId: string
  /** Any file in the project — the sync token is (project, file)-scoped. */
  fileId: string
  username: string
  sockets: number
  durationMs: number
  pingIntervalMs: number
  updateIntervalMs: number
  /** Delay between opening sockets, so the measurement is steady state and not a connect storm. */
  staggerMs: number
  /** Cell ids the sockets pretend to be viewing, for realistic presence payloads. */
  cellIds: readonly string[]
  log?: (line: string) => void
}

export interface PresenceLoadResult {
  socketsRequested: number
  socketsOpen: number
  socketsClosedEarly: number
  ping: LatencySummary
  pongsReceived: number
  framesReceived: number
  framesPerSecond: number
  framesPerSocketPerSecond: number
  updatesSent: number
  durationMs: number
  closeCodes: Record<string, number>
  errors: string[]
}

interface SocketState {
  ws: WebSocket
  frames: number
  closedEarly: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Open `sockets` presence connections, hold them for `durationMs` while each
 * pings and publishes presence, then close them and summarize.
 */
export async function runPresenceLoad(options: PresenceLoadOptions): Promise<PresenceLoadResult> {
  const log = options.log ?? (() => {})
  const token = await mintSyncToken(options.target, options.jwt, options.projectId, options.fileId)
  const states: SocketState[] = []
  const rtts: number[] = []
  const errors: string[] = []
  const closeCodes: Record<string, number> = {}
  let pongs = 0
  let updatesSent = 0

  const openOne = (index: number): Promise<SocketState> =>
    new Promise((resolve) => {
      const url = projectWsUrl(
        options.target.syncBase,
        options.projectId,
        token,
        `${options.username}-load-${index}`,
        `perf-${index.toString().padStart(4, "0")}-${Date.now().toString(36)}`,
      )
      const ws = new WebSocket(url)
      const state: SocketState = { ws, frames: 0, closedEarly: false }
      let settled = false
      ws.addEventListener("open", () => {
        settled = true
        resolve(state)
      })
      ws.addEventListener("message", (event: MessageEvent) => {
        state.frames++
        const raw = typeof event.data === "string" ? event.data : ""
        if (raw.includes('"pong"')) {
          try {
            const frame = JSON.parse(raw) as { t?: string; ts?: number }
            if (frame.t === "pong" && typeof frame.ts === "number") {
              rtts.push(Date.now() - frame.ts)
              pongs++
            }
          } catch {
            errors.push("unparseable pong frame")
          }
        }
      })
      ws.addEventListener("error", () => {
        errors.push(`socket ${index}: transport error`)
        if (!settled) {
          settled = true
          resolve(state)
        }
      })
      ws.addEventListener("close", (event: CloseEvent) => {
        const key = String(event.code)
        closeCodes[key] = (closeCodes[key] ?? 0) + 1
        state.closedEarly = true
        if (!settled) {
          settled = true
          resolve(state)
        }
      })
    })

  for (let index = 0; index < options.sockets; index++) {
    states.push(await openOne(index))
    if (options.staggerMs > 0) await sleep(options.staggerMs)
    if ((index + 1) % 10 === 0) log(`[perf] ${index + 1}/${options.sockets} sockets opened`)
  }

  // Only sockets that reached OPEN and stayed there count as capacity.
  const live = states.filter((state) => state.ws.readyState === 1)
  // Frames received while connecting are setup noise (presence snapshots for
  // every socket that joined before this one), not steady-state fan-out.
  for (const state of states) state.frames = 0
  const measuredFrom = Date.now()

  const pinger = setInterval(() => {
    for (const state of live) {
      if (state.ws.readyState !== 1) continue
      try {
        state.ws.send(JSON.stringify({ t: "ping", ts: Date.now() }))
      } catch {
        errors.push("ping send failed")
      }
    }
  }, options.pingIntervalMs)

  let updateTick = 0
  const updater = setInterval(() => {
    updateTick++
    for (const [index, state] of live.entries()) {
      if (state.ws.readyState !== 1) continue
      const cellId = options.cellIds.length > 0
        ? options.cellIds[(index + updateTick) % options.cellIds.length]
        : null
      try {
        state.ws.send(
          JSON.stringify({
            t: "presence.update",
            currentFileId: options.fileId,
            viewingCell: cellId,
          }),
        )
        updatesSent++
      } catch {
        errors.push("presence.update send failed")
      }
    }
  }, options.updateIntervalMs)

  await sleep(options.durationMs)
  clearInterval(pinger)
  clearInterval(updater)
  const durationMs = Date.now() - measuredFrom

  for (const state of states) {
    try {
      state.ws.close(1000, "perf run complete")
    } catch {
      /* already closed */
    }
  }
  // Give the close frames a moment so closeCodes is not reported half-empty.
  await sleep(250)

  const framesReceived = states.reduce((sum, state) => sum + state.frames, 0)
  const socketsOpen = live.length
  return {
    socketsRequested: options.sockets,
    socketsOpen,
    socketsClosedEarly: states.filter((state) => state.closedEarly).length,
    ping: summarize(rtts),
    pongsReceived: pongs,
    framesReceived,
    framesPerSecond: durationMs > 0 ? (framesReceived / durationMs) * 1000 : 0,
    framesPerSocketPerSecond:
      durationMs > 0 && socketsOpen > 0 ? (framesReceived / socketsOpen / durationMs) * 1000 : 0,
    updatesSent,
    durationMs,
    closeCodes,
    errors,
  }
}

/** Flat, budget-checkable metrics for a presence run. */
export function presenceMetrics(result: PresenceLoadResult): Record<string, number> {
  return {
    "presence.sockets.requested": result.socketsRequested,
    "presence.sockets.open": result.socketsOpen,
    "presence.sockets.closedEarly": result.socketsClosedEarly,
    "presence.frames.total": result.framesReceived,
    "presence.frames.perSecond": Math.round(result.framesPerSecond * 100) / 100,
    "presence.frames.perSocketPerSecond": Math.round(result.framesPerSocketPerSecond * 100) / 100,
    "presence.updates.sent": result.updatesSent,
  }
}
