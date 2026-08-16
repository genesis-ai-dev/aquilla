import { describe, it, expect } from "vitest"
import { colorFromName, initialsFromName } from "./avatar-utils"

describe("initialsFromName", () => {
  it("takes the first two letters of a single word", () => {
    expect(initialsFromName("ryder")).toBe("RY")
    expect(initialsFromName("alice")).toBe("AL")
  })

  it("uses first and last initials for multi-word names", () => {
    expect(initialsFromName("Research Editors")).toBe("RE")
    expect(initialsFromName("Anna Marie")).toBe("AM")
  })

  it("handles a single character and empty input", () => {
    expect(initialsFromName("a")).toBe("A")
    expect(initialsFromName("   ")).toBe("?")
  })
})

describe("colorFromName", () => {
  it("hashes the full team name, not the displayed initials", () => {
    const name = "Research Editors"
    expect(initialsFromName(name)).toBe("RE")
    expect(colorFromName(name)).toBe(colorFromName(name))
    expect(colorFromName(name)).not.toBe(colorFromName("R"))
    expect(colorFromName(name)).not.toBe(colorFromName("RE"))
  })

  it("trims so leading/trailing spaces do not change the color", () => {
    expect(colorFromName("  Alpha Team  ")).toBe(colorFromName("Alpha Team"))
  })
})
