import { afterEach, describe, expect, it } from "vitest"
import { __resetVoicingAsForTests, getVoicingAs, whileVoicingAs } from "./voicing-as"

afterEach(() => __resetVoicingAsForTests())

describe("Voicing as … (AQU-2212)", () => {
  it("names the voice while the work runs, and clears it after", async () => {
    let during: string | null = null
    const ok = await whileVoicingAs("c1", "Hearth", async () => {
      during = getVoicingAs("c1")
      return true
    })
    expect(ok).toBe(true)
    expect(during).toBe("Hearth")
    expect(getVoicingAs("c1")).toBeNull()
  })

  it("clears it when the work fails too", async () => {
    await expect(whileVoicingAs("c1", "Hearth", async () => { throw new Error("no") })).rejects.toThrow("no")
    expect(getVoicingAs("c1")).toBeNull()
  })
})
