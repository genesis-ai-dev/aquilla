import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  MITM_MODES,
  LISTENER_MODES,
  ADDON_MODES,
  DEFAULT_MITM_STATE,
  wantsListenerDown,
} from "./mitm-state"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

describe("wantsListenerDown", () => {
  it("keeps the listener up for pass and the addon-injected faults", () => {
    // blackhole/error need the listener up: the addon can only fault a request
    // that reaches it.
    expect(wantsListenerDown("pass", false)).toBe(false)
    expect(wantsListenerDown("blackhole", false)).toBe(false)
    expect(wantsListenerDown("error", false)).toBe(false)
  })

  it("takes the listener down for offline regardless of flap phase", () => {
    expect(wantsListenerDown("offline", false)).toBe(true)
    expect(wantsListenerDown("offline", true)).toBe(true)
  })

  it("follows the flap phase in flap mode", () => {
    expect(wantsListenerDown("flap", true)).toBe(true)
    expect(wantsListenerDown("flap", false)).toBe(false)
  })
})

describe("mode taxonomy", () => {
  it("splits every mode into exactly one owner", () => {
    // A mode owned by neither side is silently inert; a mode owned by both
    // means the addon faults requests the supervisor already blocked.
    const listener = new Set<string>(LISTENER_MODES)
    const addon = new Set<string>(ADDON_MODES)
    const overlap = [...listener].filter((m) => addon.has(m))
    expect(overlap).toEqual([])
    expect(MITM_MODES.filter((m) => m !== "pass").sort()).toEqual(
      [...LISTENER_MODES, ...ADDON_MODES].sort(),
    )
  })

  it("agrees with the addon's own mode lists", () => {
    // scripts/mitm/fault.py hardcodes these sets; a mode added on one side
    // only would be accepted by the CLI and then ignored by the proxy.
    const py = readFileSync(path.join(REPO_ROOT, "scripts", "mitm", "fault.py"), "utf8")
    const addonLine = /^ADDON_MODES = frozenset\(\{(.+)\}\)$/m.exec(py)?.[1] ?? ""
    const knownLine = /^KNOWN_MODES = ADDON_MODES \| \{(.+)\}$/m.exec(py)?.[1] ?? ""
    const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort()

    expect(quoted(addonLine)).toEqual([...ADDON_MODES].sort())
    expect([...quoted(addonLine), ...quoted(knownLine)].sort()).toEqual([...MITM_MODES].sort())
  })
})

describe("DEFAULT_MITM_STATE", () => {
  it("starts in pass so launching the harness does not break the app", () => {
    expect(DEFAULT_MITM_STATE.mode).toBe("pass")
  })

  it("stalls longer than the Rust probe's 3s timeout so blackhole registers", () => {
    // src-tauri/src/connectivity.rs builds its client with a 3s timeout; a
    // stall shorter than that would answer before the probe gives up and the
    // chip would never go offline.
    expect(DEFAULT_MITM_STATE.stallSeconds).toBeGreaterThan(3)
  })
})
