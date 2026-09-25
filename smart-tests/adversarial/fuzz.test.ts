import { describe, expect, it } from "vitest"
import { seedFor, typo, unquote } from "./fuzz"

describe("goal fuzzing", () => {
  it("reproduces the same variant from the same seed, so evidence can replay a run", () => {
    const seed = seedFor("run-1", "fuzz.edit.typo", "0")
    expect(typo("Keep this second paragraph unchanged.", seed))
      .toBe(typo("Keep this second paragraph unchanged.", seed))
  })

  it("changes exactly one word by one adjacent swap, so the reference stays recognizable", () => {
    const original = "Keep this second paragraph unchanged."
    for (let seed = 1; seed < 40; seed++) {
      const variant = typo(original, seed)
      const changed = variant.split(" ").filter((word, i) => word !== original.split(" ")[i])
      expect(changed).toHaveLength(1)
      expect([...changed[0]].sort().join("")).toBe(
        [...original.split(" ")[variant.split(" ").indexOf(changed[0])]].sort().join(""))
    }
  })

  it("varies across seeds, so repeats explore different wordings", () => {
    const variants = new Set(Array.from({ length: 20 }, (_, seed) => typo("Keep this second paragraph unchanged.", seed)))
    expect(variants.size).toBeGreaterThan(1)
  })

  it("leaves text without long words alone rather than corrupting it", () => {
    expect(typo("a b c", 7)).toBe("a b c")
  })

  it("unquotes only the named reference", () => {
    expect(unquote('Rename project "Alpha" to exactly "Beta".', "Alpha")).toBe('Rename project Alpha to exactly "Beta".')
  })
})
