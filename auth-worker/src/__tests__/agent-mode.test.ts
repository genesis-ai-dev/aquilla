// Agent-mode reader (lib/agent-mode.ts, 2026-08-28 social-workspace design §v3).
//
// WHY these assertions: `project_settings.settings` is an unvalidated JSON blob
// — the PUT/PATCH route takes `z.record(z.string(), z.unknown())` and passes
// unknown keys straight through — so this reader is the ONLY thing standing
// between a hand-edited row and a switch that spends model budget
// autonomously. Each case pins that a shape the reader cannot vouch for reads
// as the documented default (everything off, scope "full") rather than as
// consent.

import { describe, expect, it } from "vitest"
import {
  AGENT_MODE_DEFAULT,
  agentReactStateValue,
  readAgentMode,
  readAgentReactState,
} from "../lib/agent-mode"

describe("readAgentMode", () => {
  it("defaults to all-off/full when the key is absent, null, or not an object", () => {
    expect(readAgentMode(undefined)).toEqual(AGENT_MODE_DEFAULT)
    expect(readAgentMode(null)).toEqual(AGENT_MODE_DEFAULT)
    expect(readAgentMode({})).toEqual(AGENT_MODE_DEFAULT)
    expect(readAgentMode({ agentMode: null })).toEqual(AGENT_MODE_DEFAULT)
    // An array is an object to typeof; it is not a mode.
    expect(readAgentMode({ agentMode: ["react"] })).toEqual(AGENT_MODE_DEFAULT)
    expect(readAgentMode({ agentMode: "react" })).toEqual(AGENT_MODE_DEFAULT)
  })

  it("round-trips a fully specified mode", () => {
    expect(readAgentMode({ agentMode: { initiative: true, react: true, scope: "qa" } })).toEqual({
      initiative: true,
      react: true,
      scope: "qa",
    })
  })

  it("fills the missing half of a partial mode with the off default", () => {
    expect(readAgentMode({ agentMode: { react: true } })).toEqual({
      initiative: false,
      react: true,
      scope: "full",
    })
  })

  it("treats anything that is not literally `true` as off", () => {
    // The autonomous spend switch does not accept a stringly-typed yes.
    for (const value of ["true", 1, "yes", {}, []]) {
      expect(readAgentMode({ agentMode: { react: value, initiative: value } })).toEqual(
        AGENT_MODE_DEFAULT,
      )
    }
  })

  it("falls back to `full` for an unknown scope", () => {
    expect(readAgentMode({ agentMode: { scope: "everything" } }).scope).toBe("full")
    expect(readAgentMode({ agentMode: { scope: 3 } }).scope).toBe("full")
    expect(readAgentMode({ agentMode: { scope: "draft" } }).scope).toBe("draft")
  })

  it("never mutates the shared default object", () => {
    const first = readAgentMode({})
    first.react = true
    expect(readAgentMode({}).react).toBe(false)
    expect(AGENT_MODE_DEFAULT.react).toBe(false)
  })
})

describe("readAgentReactState", () => {
  it("reads an empty bookmark when absent or malformed", () => {
    expect(readAgentReactState(undefined)).toEqual({ cursor: null, lastReactionAt: {} })
    expect(readAgentReactState({ agentReactState: 7 })).toEqual({
      cursor: null,
      lastReactionAt: {},
    })
  })

  it("round-trips a cursor and cooldown stamps", () => {
    const value = agentReactStateValue({
      cursor: 1_700_000_000_000,
      lastReactionAt: { "file-a": "2026-08-28T10:00:00.000Z" },
    })
    expect(readAgentReactState({ agentReactState: value })).toEqual({
      cursor: 1_700_000_000_000,
      lastReactionAt: { "file-a": "2026-08-28T10:00:00.000Z" },
    })
  })

  it("rejects a cursor that is not a usable epoch and drops non-string stamps", () => {
    // A zero/negative/NaN cursor must read as "never swept" — reacting to the
    // whole of a project's history is exactly what the lookback default exists
    // to prevent.
    expect(readAgentReactState({ agentReactState: { cursor: 0 } }).cursor).toBeNull()
    expect(readAgentReactState({ agentReactState: { cursor: -5 } }).cursor).toBeNull()
    expect(readAgentReactState({ agentReactState: { cursor: "soon" } }).cursor).toBeNull()
    expect(
      readAgentReactState({
        agentReactState: { lastReactionAt: { good: "2026-01-01T00:00:00Z", bad: 5 } },
      }).lastReactionAt,
    ).toEqual({ good: "2026-01-01T00:00:00Z" })
  })
})
