import { describe, it, expect } from "vitest"
import { runCheck } from "./end-punctuation-mismatch"

describe("end-punctuation-mismatch", () => {
  it("returns null when both end with question mark", () => {
    expect(runCheck("Where are you?", "¿Dónde estás?")).toBeNull()
  })

  it("returns null when both end with exclamation", () => {
    expect(runCheck("Stop!", "¡Detente!")).toBeNull()
  })

  it("flags source-? but target-.", () => {
    expect(runCheck("Where are you?", "Donde estas.")).not.toBeNull()
  })

  it("flags target adds ! when source has .", () => {
    expect(runCheck("He went home.", "Il est rentré!")).not.toBeNull()
  })

  it("returns null when neither has terminal punctuation", () => {
    expect(runCheck("first clause", "première clause")).toBeNull()
  })

  it("recognizes CJK terminal punctuation", () => {
    expect(runCheck("Where?", "你在哪里？")).toBeNull()
    expect(runCheck("Stop!", "停！")).toBeNull()
  })

  it("ignores trailing whitespace", () => {
    expect(runCheck("Hello?", "Bonjour?  \n")).toBeNull()
  })
})
