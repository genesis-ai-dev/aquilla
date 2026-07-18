/**
 * slash-commands tests — expansion rules: known commands expand (with or
 * without a scope), unknown or bare text passes through, /find requires an
 * argument.
 */

import { describe, it, expect } from "vitest"
import { expandSlashCommand } from "./slash-commands"

describe("expandSlashCommand", () => {
  it("expands /draft with and without a scope", () => {
    expect(expandSlashCommand("/draft MRK 4")).toContain("untranslated cells in MRK 4")
    expect(expandSlashCommand("/draft")).toContain("the open file")
    expect(expandSlashCommand("  /draft MRK 4:1-20 ")).toContain("MRK 4:1-20")
  })

  it("expands /check, /find, and /status", () => {
    expect(expandSlashCommand("/check GEN 1")).toContain("Check the translated cells in GEN 1")
    expect(expandSlashCommand("/find living water")).toContain('"living water"')
    expect(expandSlashCommand("/status")).toContain("progress summary")
  })

  it("passes through non-commands and unknown commands", () => {
    expect(expandSlashCommand("draft MRK 4")).toBeNull()
    expect(expandSlashCommand("/frobnicate now")).toBeNull()
    expect(expandSlashCommand("hello /draft")).toBeNull()
  })

  it("/find without an argument is not a command", () => {
    expect(expandSlashCommand("/find")).toBeNull()
    expect(expandSlashCommand("/find   ")).toBeNull()
  })
})
