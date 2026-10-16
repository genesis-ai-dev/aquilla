import { describe, expect, it } from "vitest"
import { laneTargetLanguages, resolveActiveTargetLanguage } from "./project-workspace-lane-target"
import { planNewTargetLane } from "@/lib/lanes/lane-create"

describe("resolveActiveTargetLanguage (AQU-602)", () => {
  it("uses the active lane tag as the target language for a non-default lane", () => {
    // Switching to the 'es' lane must translate into Spanish, regardless of the
    // file/project default target — the core AQU-602 regression. With no lane
    // rows (a server that predates AQU-1418) the tag is all there is.
    expect(resolveActiveTargetLanguage("es", "fr", { targetLanguage: "fr" })).toBe("es")
    expect(resolveActiveTargetLanguage("swh", undefined, { targetLanguage: "fr" })).toBe("swh")
    expect(resolveActiveTargetLanguage("fr-CA", "fr-BE", { targetLanguage: "French" })).toBe("fr-CA")
  })

  it("ignores the file stamp and settings for the default lane when there is no row (AQU-1595)", () => {
    // The per-file target is an import-time snapshot, and the settings key is
    // not the lane. With no row, `''` names no language — so the caller shows
    // "Set target language" rather than either of those strings.
    expect(resolveActiveTargetLanguage("", "fr", { targetLanguage: "es" })).toBeUndefined()
    expect(resolveActiveTargetLanguage("", null, { targetLanguage: "es" })).toBeUndefined()
    expect(resolveActiveTargetLanguage("", undefined, { targetLanguage: "es" })).toBeUndefined()
  })

  it("returns undefined when the project has no target, even if a file carries one (AQU-583)", () => {
    // ...and when the project has no target the default lane has none — so the
    // caller shows "Set target language" rather than a stamped file language
    // (e.g. "English"), regardless of how many files were imported.
    expect(resolveActiveTargetLanguage("", "English", null)).toBeUndefined()
    expect(resolveActiveTargetLanguage("", "fr", undefined)).toBeUndefined()
    expect(resolveActiveTargetLanguage("", "fr", { targetLanguage: "" })).toBeUndefined()
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
    expect(resolveActiveTargetLanguage("a3f09c1e", null, { targetLanguage: "Spanish" }, lanes)).toBe("Spanish")
  })

  it("leaves a lane whose tag IS a language exactly as it was", () => {
    // Nothing that already worked may change: this lane's tag is its language,
    // so it keeps going to the model verbatim rather than becoming "fra".
    expect(resolveActiveTargetLanguage("fr-CA", "fr-BE", { targetLanguage: "Spanish" }, lanes)).toBe("fr-CA")
  })

  it("uses the lane's name when its language is not in the code registry", () => {
    expect(
      resolveActiveTargetLanguage("b0b0b0b0", null, { targetLanguage: "Spanish" }, [
        { id: "b0b0b0b0", name: "Nuer", langCode: null, legacyTag: "b0b0b0b0" },
      ]),
    ).toBe("Nuer")
  })

  it("does not inherit the project target for an id-tagged lane that records no language (AQU-1593)", () => {
    // The migration fallback is only the source lane and legacy_tag ''. An
    // id-tagged lane with nothing else is unset — never the hex id, and never
    // the project's target language.
    expect(
      resolveActiveTargetLanguage("b0b0b0b0", null, { targetLanguage: "Spanish" }, [
        { id: "b0b0b0b0", name: "", langCode: null, legacyTag: "b0b0b0b0" },
      ]),
    ).toBeUndefined()
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
      resolveActiveTargetLanguage("", "English", { targetLanguage: "Spanish" }, [
        { id: "defa0001", language: "French", name: null, langCode: null, legacyTag: "" },
      ]),
    ).toBe("French")
    // No rows: settings are not the default lane's language.
    expect(resolveActiveTargetLanguage("", "fr", { targetLanguage: "es" })).toBeUndefined()
    // An un-backfilled row answers from its name, not from settings.
    expect(
      resolveActiveTargetLanguage("", "fr", { targetLanguage: "es" }, [
        { id: "defa0001", language: null, name: "Nuer", langCode: null, legacyTag: "" },
      ]),
    ).toBe("Nuer")
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
    const target = resolveActiveTargetLanguage(plan.legacyTag, null, { targetLanguage: "Spanish" }, [row])
    expect(target).toBe(language)
    // The point of the ticket: whatever we send, it is never the lane id.
    expect(target).not.toBe(laneId)
    if (language === "Yoruba") {
      expect(
        resolveActiveTargetLanguage(plan.legacyTag, null, { targetLanguage: "Spanish" }, [{ ...row, language: "Yoruba (Oyo)" }]),
      ).toBe("Yoruba (Oyo)")
    }
  })
})

describe("laneTargetLanguages — the Import dialog's translation check (AQU-1365, AQU-1586)", () => {
  // The check compares an upload's declared language with each lane's. A lane
  // tagged with its own opaque id must be compared by its row's typed language
  // (AQU-1592), not its display name, its code, or that id — or a Spanish
  // upload never matches the second Spanish lane and a hex id is offered up
  // as a language.
  const rows = [
    { id: "defa0001", role: "target" as const, language: "Spanish", name: "Spanish", langCode: "es", legacyTag: "" },
    { id: "a3f09c1e", role: "target" as const, language: "Spanish", name: "Spanish (Mexico team)", langCode: "es", legacyTag: "a3f09c1e" },
    { id: "frc00002", role: "target" as const, language: "fr-CA", name: "French (Canada)", langCode: "fra", legacyTag: "fr-CA" },
    { id: "b0b0b0b0", role: "target" as const, language: null, name: "", langCode: null, legacyTag: "b0b0b0b0" },
  ]
  const labels = { "": "Spanish", a3f09c1e: "Spanish (Mexico team)", "fr-CA": "French (Canada)" }

  it("reads a lane's language from its row, never its id, and marks the open lane", () => {
    expect(laneTargetLanguages(["", "a3f09c1e", "fr-CA"], "a3f09c1e", { targetLanguage: "Spanish" }, labels, rows)).toEqual([
      { language: "Spanish", label: "Spanish", active: false },
      { language: "Spanish", label: "Spanish (Mexico team)", active: true },
      { language: "fr-CA", label: "French (Canada)", active: false },
    ])
  })

  it("leaves out an id-tagged lane that records no language, and keeps a typed default lane", () => {
    expect(laneTargetLanguages(["", "b0b0b0b0"], "", { targetLanguage: "" }, {}, rows)).toEqual([
      { language: "Spanish", label: null, active: true },
    ])
  })

  it("uses a non-empty tag when no row matches, and a row's name rather than settings", () => {
    // `''` is not a language, and settings are not consulted. `tt` has no row,
    // so the tag itself is the language a pre-lane server can still name.
    expect(laneTargetLanguages(["", "tt"], "tt", { targetLanguage: "Siberian Tatar" }, {})).toEqual([
      { language: "tt", label: null, active: true },
    ])
    expect(
      laneTargetLanguages(["", "tt"], "tt", { targetLanguage: "Spanish" }, {}, [
        { id: "defl0001", role: "target", language: null, name: "Siberian Tatar", langCode: null, legacyTag: "" },
      ]),
    ).toEqual([
      { language: "Siberian Tatar", label: null, active: false },
      { language: "tt", label: null, active: true },
    ])
  })
})
