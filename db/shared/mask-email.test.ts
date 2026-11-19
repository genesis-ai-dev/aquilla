// AQU-2576 — the masking rule the join-link rejection leans on.
//
// The rejection has to NAME the address an invite was minted for, to someone
// who is provably not its owner. These cases pin the two properties that makes
// safe: the output never reproduces the input's local part, and the domain
// survives so the invited person can still recognise their own address.

import { describe, it, expect } from "vitest"
import { maskEmail, looksLikeEmail } from "./mask-email"

describe("maskEmail (AQU-2576)", () => {
  const cases: Array<[string, string, string]> = [
    ["keeps first and last of the local part", "naladda@proton.me", "n…a@proton.me"],
    ["masks a three-character local part", "abc@x.io", "a…c@x.io"],
    ["keeps only the first of a two-character local part", "ab@x.io", "a…@x.io"],
    ["drops a one-character local part entirely", "a@x.io", "…@x.io"],
    ["trims before masking", "  naladda@proton.me  ", "n…a@proton.me"],
    ["keeps a subdomained domain intact", "manal@mail.biblica.com", "m…l@mail.biblica.com"],
    ["splits on the LAST @", "od d@d@proton.me", "o…d@proton.me"],
    ["masks a string with no @ whole", "notanemail", "…"],
    ["masks a leading-@ string whole", "@proton.me", "…"],
    ["masks a trailing-@ string whole", "naladda@", "…"],
    ["masks empty input whole", "", "…"],
  ]
  it.each(cases)("%s", (_label, input, expected) => {
    expect(maskEmail(input)).toBe(expected)
  })

  it("masks null/undefined rather than rendering them", () => {
    expect(maskEmail(null)).toBe("…")
    expect(maskEmail(undefined)).toBe("…")
  })

  it("never reproduces the local part it was given", () => {
    for (const [, input] of cases) {
      const at = input.trim().lastIndexOf("@")
      if (at <= 0) continue
      expect(maskEmail(input)).not.toBe(input.trim())
    }
  })
})

describe("looksLikeEmail (AQU-2576)", () => {
  it.each([
    ["naladda@proton.me", true],
    ["a@b", true],
    ["Naladda", false],
    ["@proton.me", false],
    ["naladda@", false],
    ["two words@proton.me", false],
    ["", false],
  ] as Array<[string, boolean]>)("%s → %s", (input, expected) => {
    expect(looksLikeEmail(input)).toBe(expected)
  })
})
