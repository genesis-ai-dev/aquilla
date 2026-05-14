import { describe, it, expect } from "vitest"
import { runCheck } from "./unpaired-symbols"

describe("unpaired-symbols", () => {
  it("flags missing closing paren", () => {
    expect(runCheck("Note (see ref) here", "Note (voir réf ici")).not.toBeNull()
  })

  it("flags missing opening bracket", () => {
    expect(runCheck("Edit [draft]", "Modifier draft]")).not.toBeNull()
  })

  it("returns null when balanced", () => {
    expect(runCheck("Note (see ref)", "Note (voir réf)")).toBeNull()
  })

  it("suppresses when source has same imbalance", () => {
    expect(runCheck("partial (no close", "partiel (sans fermer")).toBeNull()
  })

  it("returns null when no symbols", () => {
    expect(runCheck("Hello", "Bonjour")).toBeNull()
  })
})
