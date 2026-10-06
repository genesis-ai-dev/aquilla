import { describe, expect, it } from "vitest"
import { laneTargetLanguages, resolveActiveTargetLanguage } from "./project-workspace-lane-target"
import { planNewTargetLane } from "@/lib/lanes/lane-create"

describe("resolveActiveTargetLanguage (AQU-602)", () => {
  it("uses the active lane tag as the target language for a non-default lane", () => {
    // Switching to the 'es' lane must translate into Spanish, regardless of the
    // file/project default target — the core AQU-602 regression. With no lane
    // rows (a server that predates AQU-1418) the tag is all there is.
    expect(resolveActiveTargetLanguage("es", "fr", "fr")).toBe("es")
    expect(resolveActiveTargetLanguage("swh", undefined, "fr")).toBe("swh")
    expect(resolveActiveTargetLanguage("fr-CA", "fr-BE", "French")).toBe("fr-CA")
  })

  it("uses only the project target for the default lane, ignoring the file (AQU-583)", () => {
    // The per-file target is an import-time snapshot. On the default lane the
    // project setting is authoritative: it wins over any file value...
    expect(resolveActiveTargetLanguage("", "fr", "es")).toBe("es")
    expect(resolveActiveTargetLanguage("", null, "es")).toBe("es")
    expect(resolveActiveTargetLanguage("", undefined, "es")).toBe("es")
  })

  it("returns undefined when the project has no target, even if a file carries one (AQU-583)", () => {
    // ...and when the project has no target the default lane has none — so the
    // caller shows "Set target language" rather than a stamped file language
    // (e.g. "English"), regardless of how many files were imported.
    expect(resolveActiveTargetLanguage("", "English", null)).toBeUndefined()
    expect(resolveActiveTargetLanguage("", "fr", undefined)).toBeUndefined()
    expect(resolveActiveTargetLanguage("", "fr", "")).toBeUndefined()
    expect(resolveActiveTargetLanguage("", null, null)).toBeUndefined()
    expect(resolveActiveTargetLanguage("", undefined, undefined)).toBeUndefined()
  })
})

describe("resolveActiveTargetLanguage — the language comes from the lane row (AQU-1586)", () => {
  // `planNewTargetLane` hands a lane the opaque 8-hex lane id as its
  // `legacy_tag` whenever the language string is already taken by a sibling or
  // matches the project default. A second Spanish lane in a Spanish project is
  // therefore tagged `a3f09c1e`, and reading that tag as the language drafted
  // "into a3f09c1e".
  const lanes = [
    { id: "defa0001", language: "Spanish", name: null, langCode: "es", legacyTag: "" },
    { id: "a3f09c1e", language: "Spanish", name: "Spanish (Mexico team)", langCode: "es", legacyTag: "a3f09c1e" },
    { id: "frc00002", language: "fr-CA", name: "French (Canada)", langCode: "fra", legacyTag: "fr-CA" },
  ]

  it("sends the lane's LANGUAGE, not its id, for a lane tagged with its own id", () => {
    expect(resolveActiveTargetLanguage("a3f09c1e", null, "Spanish", lanes)).toBe("Spanish")
  })

  it("leaves a lane whose tag IS a language exactly as it was", () => {
    // Nothing that already worked may change: this lane's tag is its language,
    // so it keeps going to the model verbatim rather than becoming "fra".
    expect(resolveActiveTargetLanguage("fr-CA", "fr-BE", "Spanish", lanes)).toBe("fr-CA")
  })

  it("uses the lane's name when its language is not in the code registry", () => {
    expect(
      resolveActiveTargetLanguage("b0b0b0b0", null, "Spanish", [
        { id: "b0b0b0b0", name: "Nuer", langCode: null, legacyTag: "b0b0b0b0" },
      ]),
    ).toBe("Nuer")
  })

  it("inherits the project target when the row records no language", () => {
    // Never the lane id, and never an empty string either: an empty target
    // language would substitute into the prompt as nothing at all. A lane that
    // records none inherits the project's, exactly as the default lane does.
    expect(
      resolveActiveTargetLanguage("b0b0b0b0", null, "Spanish", [
        { id: "b0b0b0b0", name: "", langCode: null, legacyTag: "b0b0b0b0" },
      ]),
    ).toBe("Spanish")
  })

  it("is undefined only when nothing at all records a target language", () => {
    // Then — and only then — the caller shows "Set target language".
    expect(
      resolveActiveTargetLanguage("b0b0b0b0", "English", null, [
        { id: "b0b0b0b0", name: "", langCode: null, legacyTag: "b0b0b0b0" },
      ]),
    ).toBeUndefined()
  })

  it("sends the default lane's stored language, and still ignores the file", () => {
    expect(
      resolveActiveTargetLanguage("", "English", "Spanish", [
        { id: "defa0001", language: "French", name: null, langCode: null, legacyTag: "" },
      ]),
    ).toBe("French")
    // No rows: the project target remains the fallback.
    expect(resolveActiveTargetLanguage("", "fr", "es")).toBe("es")
  })

  // AGENTS.md rule 12: run the real PRODUCER's output through the consumer.
  // A synthetic lane row cannot catch a change in how `planNewTargetLane`
  // chooses a tag — which is the half of this bug that lives upstream.
  it.each([
    ["the language matches the project default", "Spanish"],
    ["a sibling lane already holds the language", "Yoruba"],
  ])("plan → row → editor target, when %s", (_case, language) => {
    const laneId = "a3f09c1e"
    const plan = planNewTargetLane({
      laneId,
      // A second lane of a language needs its own display name — the planner
      // refuses a duplicate — which is precisely why the language cannot be
      // read back off the name.
      name: `${language} (second team)`,
      language,
      targetLanguage: "Spanish",
      existing: [
        { id: "defa0001", name: "Spanish", legacyTag: "" },
        { id: "sib00003", name: "Yoruba", legacyTag: "Yoruba" },
      ],
    })
    if (!plan.ok) throw new Error(`planNewTargetLane refused the lane: ${plan.problem}`)
    // The tag the planner picked really is the opaque lane id — that is the
    // precondition this bug needs, so assert it rather than assume it.
    expect(plan.legacyTag).toBe(laneId)

    const row = {
      id: laneId,
      language: plan.language,
      name: plan.name,
      langCode: plan.langCode,
      legacyTag: plan.legacyTag,
    }
    const target = resolveActiveTargetLanguage(plan.legacyTag, null, "Spanish", [row])
    expect(target).toBe(language)
    // The point of the ticket: whatever we send, it is never the lane id.
    expect(target).not.toBe(laneId)
    if (language === "Yoruba") {
      expect(
        resolveActiveTargetLanguage(plan.legacyTag, null, "Spanish", [{ ...row, language: "Yoruba (Oyo)" }]),
      ).toBe("Yoruba (Oyo)")
    }
  })
})

describe("laneTargetLanguages — the Import dialog's translation check (AQU-1365, AQU-1586)", () => {
  // The check compares an upload's declared language with each lane's. A lane
  // tagged with its own opaque id must be compared by its row's language, or a
  // Spanish upload never matches the second Spanish lane and a hex id is
  // offered up as a language.
  const rows = [
    { id: "defa0001", role: "target" as const, name: "Spanish", langCode: "es", legacyTag: "" },
    { id: "a3f09c1e", role: "target" as const, name: "Spanish (Mexico team)", langCode: "es", legacyTag: "a3f09c1e" },
    { id: "frc00002", role: "target" as const, name: "French (Canada)", langCode: "fra", legacyTag: "fr-CA" },
    { id: "b0b0b0b0", role: "target" as const, name: "", langCode: null, legacyTag: "b0b0b0b0" },
  ]
  const labels = { "": "Spanish", a3f09c1e: "Spanish (Mexico team)", "fr-CA": "French (Canada)" }

  it("reads a lane's language from its row, never its id, and marks the open lane", () => {
    expect(laneTargetLanguages(["", "a3f09c1e", "fr-CA"], "a3f09c1e", "Spanish", labels, rows)).toEqual([
      { language: "Spanish", label: "Spanish", active: false },
      { language: "es", label: "Spanish (Mexico team)", active: true },
      { language: "fr-CA", label: "French (Canada)", active: false },
    ])
  })

  it("leaves out a lane whose row records no language, and a default lane with no project target", () => {
    expect(laneTargetLanguages(["", "b0b0b0b0"], "", "", {}, rows)).toEqual([])
  })

  it("falls back to the tag only when there are no rows at all", () => {
    expect(laneTargetLanguages(["", "tt"], "tt", "Siberian Tatar", {})).toEqual([
      { language: "Siberian Tatar", label: null, active: false },
      { language: "tt", label: null, active: true },
    ])
  })
})
