import { describe, it, expect } from "vitest"
import { colorFromName, initialsFromName, singleInitialFromName } from "./avatar-utils"

describe("colorFromName", () => {
  it("hashes the full team name, not the displayed initials", () => {
    const name = "Research Editors"
    // List avatar shows "RE"; previously-viewed shows "R" — color must match.
    expect(initialsFromName(name)).toBe("RE")
    expect(singleInitialFromName(name)).toBe("R")
    expect(colorFromName(name)).toBe(colorFromName(name))
    expect(colorFromName(name)).not.toBe(colorFromName("R"))
    expect(colorFromName(name)).not.toBe(colorFromName("RE"))
  })

  it("trims so leading/trailing spaces do not change the color", () => {
    expect(colorFromName("  Alpha Team  ")).toBe(colorFromName("Alpha Team"))
  })
})
