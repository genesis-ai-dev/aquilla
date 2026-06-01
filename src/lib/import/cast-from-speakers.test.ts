import { describe, it, expect } from "vitest"
import { buildCastAdditions } from "./cast-from-speakers"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

describe("buildCastAdditions", () => {
  it("creates one voice per new distinct speaker and assigns cells, reusing existing names", () => {
    const existing: ProjectTtsSettings = { voices: [{ id: "v-mary", name: "Mary", color: "#ec4899" }] }
    const result = buildCastAdditions(
      [
        { cellId: "c1", speaker: "Mary" },   // reuse existing
        { cellId: "c2", speaker: "John" },   // new
        { cellId: "c3", speaker: "John" },   // reuse the just-created John
        { cellId: "c4", speaker: undefined }, // no speaker → no assignment
      ],
      existing,
      () => "new-id",  // deterministic id minter for the test
    )
    // Mary already existed; only John is added.
    expect(result.voices.map((v) => v.name)).toEqual(["Mary", "John"])
    expect(result.castAssignments).toEqual({ c1: "v-mary", c2: "new-id", c3: "new-id" })
  })

  it("returns a no-op when there are no speakers, preserving the Narrator built-in as default", () => {
    // When the voice library is empty, getVoiceLibrary falls back to PRESET_VOICES (Narrator).
    // No new voices should be added, and castAssignments must be empty.
    const existing: ProjectTtsSettings = { voices: [] }
    const result = buildCastAdditions([{ cellId: "c1", speaker: undefined }], existing, () => "x")
    expect(result.castAssignments).toEqual({})
    // Narrator preset is preserved as library[0]; no custom voices added.
    expect(result.voices.every((v) => v.builtIn)).toBe(true)
    expect(result.voices.length).toBe(1)
  })
})
