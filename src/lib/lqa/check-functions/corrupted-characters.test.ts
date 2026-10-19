import { describe, it, expect } from "vitest"
import { runCheck } from "./corrupted-characters"

describe("corrupted-characters", () => {
  it("flags the replacement character a failed decode leaves behind", () => {
    const spans = runCheck("He said.", "Il a dit�.")
    expect(spans).toEqual([{ side: "target", start: 8, end: 9, matchedText: "�" }])
  })

  it("flags UTF-8 read as Windows-1252 (é → Ã©, ’ → â€™)", () => {
    expect(runCheck("He went home.", "Il est allÃ© Ã\u00A0la maison")!.map((s) => s.matchedText)).toEqual(["Ã©", "Ã\u00A0"])
    expect(runCheck("It's", "Câ€™est")!.map((s) => s.matchedText)).toEqual(["â€™"])
  })

  it("flags stray control characters but not tabs or line breaks", () => {
    expect(runCheck("a", "un\u0007mot")).not.toBeNull()
    expect(runCheck("a", "un\tmot\nici\r\n")).toBeNull()
  })

  it("leaves real accented capitals alone (Portuguese SÃO, French Â)", () => {
    expect(runCheck("SAINT PAUL", "SÃO PAULO")).toBeNull()
    expect(runCheck("SOUL", "ÂME")).toBeNull()
  })

  it("doesn't blame the translation for damage that came in with the source", () => {
    expect(runCheck("cafÃ©", "cafÃ©")).toBeNull()
  })
})
