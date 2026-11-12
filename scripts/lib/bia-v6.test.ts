import { describe, expect, it } from "vitest"
import { buildV6 } from "./bia-v6"

describe("V6 reconstruction (eval baseline)", () => {
  it("ranks forward followers of the last word by count, across cell boundaries", () => {
    const v6 = buildV6([["the", "king", "rose"], ["the", "king", "sat"], ["the", "land"], ["wept"]])
    expect(v6.next(["the"]).slice(0, 2)).toEqual(["king", "land"])
    // "land" ends a cell; V6's corpus stream continues into the next verse.
    expect(v6.next(["land"])[0]).toBe("wept")
  })

  it("falls back to the second-to-last word and appends similar words", () => {
    const v6 = buildV6([["a", "b", "c"], ["a", "x", "c"]])
    // "zzz" is unseen: use "a"'s followers.
    expect(v6.next(["a", "zzz"]).slice(0, 2)).toEqual(["b", "x"])
    // "b" is followed only by "c"; "x" fits the same (a, c) slot, so it is appended.
    const out = v6.next(["b"])
    expect(out[0]).toBe("c")
    expect(out).toContain("x")
  })
})
