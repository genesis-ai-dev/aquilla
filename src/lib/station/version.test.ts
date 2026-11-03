// AQU-2327: a take's version number, as its name shows it.
import { describe, expect, it } from "vitest"
import { versionOfId } from "./version"

describe("a take's version", () => {
  const atts = {
    t2: { referenceAudioId: null },
    v2: { referenceAudioId: "t2" },
    gone: { referenceAudioId: "t2", isDeleted: true },
    v2over: { referenceAudioId: "v2gone" },
    v2gone: { referenceAudioId: "t2", isDeleted: true },
  }
  it("counts the takes it was made from", () => {
    expect(versionOfId(atts, null)).toBe(1)
    expect(versionOfId(atts, "t2")).toBe(2)
  })
  it("doesn't count a take it was saved over, so Save keeps the name (Nov 2)", () => {
    expect(versionOfId({ t2: { referenceAudioId: null, isDeleted: true } }, "t2")).toBe(1)
    // A version saved over keeps its number: version 2 still.
    expect(versionOfId(atts, "v2gone")).toBe(2)
  })
})
