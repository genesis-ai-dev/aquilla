import { describe, it, expect } from "vitest"
import { upsertVoice } from "./voices"
import type { Voice } from "@/lib/parsers/types"

function voice(over: Partial<Voice> = {}): Voice {
  return { id: "v-1", name: "Narrator", color: "#475569", ...over }
}

describe("upsertVoice", () => {
  it("appends a new voice and pins it as default when none is set", () => {
    const added = voice({ id: "v-clone", name: "Clone" })
    expect(upsertVoice([voice()], added, undefined)).toEqual({
      voices: [voice(), added],
      defaultVoiceId: "v-1",
    })
  })

  it("replaces an existing voice by id without changing default", () => {
    const original = voice({ name: "Old" })
    const updated = voice({ name: "New" })
    expect(upsertVoice([original], updated, "v-1")).toEqual({
      voices: [updated],
      defaultVoiceId: "v-1",
    })
  })
})
