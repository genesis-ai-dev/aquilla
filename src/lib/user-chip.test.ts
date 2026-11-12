import { describe, expect, it } from "vitest"
import {
  USER_CHIP_SHAPES,
  appearanceForUserId,
  usernameForChip,
} from "./user-chip"

describe("usernameForChip", () => {
  it("keeps a real username and drops blanks and placeholders", () => {
    expect(usernameForChip("  ryder  ")).toBe("ryder")
    expect(usernameForChip("")).toBeNull()
    expect(usernameForChip("   ")).toBeNull()
    expect(usernameForChip(null)).toBeNull()
    expect(usernameForChip(undefined)).toBeNull()
    expect(usernameForChip("local")).toBeNull()
    expect(usernameForChip("Anonymous")).toBeNull()
  })

  it("does not treat the anonymous label or a pseudonym as missing", () => {
    expect(usernameForChip("User")).toBe("User")
    expect(usernameForChip("u_3f9ab21c")).toBe("u_3f9ab21c")
  })
})

describe("appearanceForUserId", () => {
  it("is stable for one id and identical for the same id written two ways", () => {
    expect(appearanceForUserId(77)).toEqual(appearanceForUserId("77"))
    expect(appearanceForUserId("77")).toEqual(appearanceForUserId("77"))
  })

  it("can tell two ids apart", () => {
    const seen = new Set<string>()
    for (let id = 1; id <= 80; id++) {
      const mark = appearanceForUserId(id)
      expect(USER_CHIP_SHAPES).toContain(mark.shape)
      expect(mark.color.startsWith("hsl(")).toBe(true)
      seen.add(`${mark.shape}|${mark.color}`)
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it("uses one neutral mark when there is no id", () => {
    expect(appearanceForUserId(null)).toEqual(appearanceForUserId(""))
    expect(appearanceForUserId(null).shape).toBe("circle")
  })
})
