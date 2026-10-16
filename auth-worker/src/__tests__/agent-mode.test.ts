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
import { AGENT_MODE_DEFAULT, readAgentMode } from "../lib/agent-mode"

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
