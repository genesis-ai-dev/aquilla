import { describe, it, expect } from "vitest"
import { runCheck } from "./end-punctuation-mismatch"
import { resolvePunctuation } from "../../../../db/shared/punctuation-conventions"

/** The context the editor passes for a lane in `language` (AQU-1906). */
const lane = (language: string) => ({ punctuation: resolvePunctuation({ language }).conventions })

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

  it("marks missing target punctuation as a zero-width issue at the end", () => {
    expect(runCheck("Where are you?", "Donde estas")).toEqual([{
      side: "target",
      start: 11,
      end: 11,
      matchedText: "",
    }])
  })

  it("underlines the actual target punctuation when the punctuation class is wrong", () => {
    expect(runCheck("Where are you?", "Donde estas.")).toEqual([{
      side: "target",
      start: 11,
      end: 12,
      matchedText: ".",
    }])
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

  // AQU-1906 — the target lane's own conventions.
  describe("target-language conventions", () => {
    it("accepts no terminal mark at all in a Thai lane", () => {
      expect(runCheck("He went home.", "เขากลับบ้าน", lane("Thai"))).toBeNull()
    })

    it("still flags a wrong-class mark in a Thai lane", () => {
      expect(runCheck("He went home.", "เขากลับบ้าน?", lane("Thai"))).not.toBeNull()
    })

    it("accepts the Arabic question mark for a source question", () => {
      expect(runCheck("Where are you?", "أين أنت؟", lane("ar"))).toBeNull()
    })

    it("accepts the Greek question mark (;) for a source question", () => {
      expect(runCheck("Where are you?", "Πού είσαι;", lane("el"))).toBeNull()
    })

    it("flags a Greek translation that ends in a full stop where the source asks", () => {
      expect(runCheck("Where are you?", "Πού είσαι.", lane("el"))).not.toBeNull()
    })

    it("accepts the Devanagari danda, the Armenian verjaket and the Burmese pote ma", () => {
      expect(runCheck("He went home.", "वह घर गया।", lane("hi"))).toBeNull()
      expect(runCheck("He went home.", "Նա տուն գնաց։", lane("hy"))).toBeNull()
      expect(runCheck("He went home.", "သူအိမ်ပြန်သွားသည်။", lane("my"))).toBeNull()
    })

    it("still flags a genuine drop in a Spanish lane — the table says nothing about Spanish", () => {
      expect(runCheck("Where are you?", "Dónde estás", lane("Spanish"))).not.toBeNull()
    })

    it("behaves exactly as with no lane when the lane records no language", () => {
      expect(runCheck("Where are you?", "Donde estas", lane(""))).toEqual(
        runCheck("Where are you?", "Donde estas"),
      )
    })

    it("honours a Language profile that says the lane uses no terminal mark", () => {
      const profile = { punctuation: resolvePunctuation({ language: "es", profile: { noTerminalMark: true } }).conventions }
      expect(runCheck("Where are you?", "Dónde estás", profile)).toBeNull()
    })
  })
})
