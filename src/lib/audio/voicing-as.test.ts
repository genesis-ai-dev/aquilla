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

// AQU-1758: two voicings of one line can overlap — a Regenerate from the take
// menu, then "Change to Naomi" on the same line before it finishes. Each
// clears only its own "Voicing as …", so the line keeps naming the one still
// running.
describe("two voicings of one line at once (AQU-1758)", () => {
  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    return { promise, resolve }
  }

  it("the first to finish leaves the other's status", async () => {
    const regenerate = deferred()
    const change = deferred()
    const first = whileVoicingAs("c1", "Narrator", () => regenerate.promise)
    const second = whileVoicingAs("c1", "Naomi", () => change.promise)
    expect(getVoicingAs("c1")).toBe("Naomi")
    regenerate.resolve()
    await first
    expect(getVoicingAs("c1")).toBe("Naomi")
    change.resolve()
    await second
    expect(getVoicingAs("c1")).toBeNull()
  })

  it("the last started finishing first shows the one still running again", async () => {
    const regenerate = deferred()
    const change = deferred()
    const first = whileVoicingAs("c1", "Narrator", () => regenerate.promise)
    const second = whileVoicingAs("c1", "Naomi", () => change.promise)
    change.resolve()
    await second
    expect(getVoicingAs("c1")).toBe("Narrator")
    regenerate.resolve()
    await first
    expect(getVoicingAs("c1")).toBeNull()
  })

  it("another line's voicing is its own", async () => {
    const other = deferred()
    const running = whileVoicingAs("c2", "Hearth", () => other.promise)
    await whileVoicingAs("c1", "Naomi", async () => {})
    expect(getVoicingAs("c2")).toBe("Hearth")
    other.resolve()
    await running
  })
})
