// Shared shape of the fault state file written by `scripts/mitm-mode.ts`, read
// by `scripts/tauri-dev-mitm.ts` (which owns the listener) and by
// `scripts/mitm/fault.py` (which injects the listener-up faults).
//
// Responsibility is split because mitmproxy 12 does not invoke its
// `websocket_*` hooks for connections it reverse-proxies — it relays the
// upgraded socket raw — and exposes no way to drop an established connection
// from an addon. So a fault that must kill live sockets (the sync WebSocket
// above all) is applied by stopping the listener process, not from the addon.
// See docs/TAURI-NETWORK-FAULTS.md for the evidence behind that split.

import { renameSync, writeFileSync } from "node:fs"

/** Faults applied by taking the listener down — these drop live sockets. */
export const LISTENER_MODES = ["offline", "flap"] as const
/** Faults applied by the addon, with the listener up and forwarding. */
export const ADDON_MODES = ["blackhole", "error"] as const

export const MITM_MODES = ["pass", ...LISTENER_MODES, ...ADDON_MODES] as const

export type MitmMode = (typeof MITM_MODES)[number]

export interface MitmState {
  mode: MitmMode
  /** `error` mode's status code. */
  status: number
  /** `blackhole` mode's hold, in seconds. */
  stallSeconds: number
  /** `flap` mode's half-period: N seconds up, N seconds down. */
  periodSeconds: number
}

export const DEFAULT_MITM_STATE: MitmState = {
  mode: "pass",
  status: 503,
  stallSeconds: 600,
  periodSeconds: 20,
}

/** True when `mode` requires the listener to be down right now. */
export function wantsListenerDown(mode: MitmMode, flapPhaseDown: boolean): boolean {
  if (mode === "offline") return true
  if (mode === "flap") return flapPhaseDown
  return false
}

/**
 * Parses the state file's contents, returning `fallback` for anything that is
 * not a complete, valid state. Readers poll the file while `mitm-mode.ts` may
 * be writing it, so an unreadable or unknown value must mean "no change" —
 * snapping to `pass` would briefly heal an outage mid-observation.
 */
export function parseMitmState(raw: string, fallback: MitmState): MitmState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback
  const state = { ...DEFAULT_MITM_STATE, ...(parsed as Partial<MitmState>) }
  if (!MITM_MODES.includes(state.mode)) return fallback
  return state
}

/**
 * Writes the state file via temp-file + rename, so a concurrent reader sees
 * either the old contents or the new ones — never a truncated file.
 */
export function writeMitmStateFile(file: string, state: object): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, file)
}
