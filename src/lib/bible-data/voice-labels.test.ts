// AQU-1687 — the label chain for speaker and addressee names.
//
// What these tests protect (04-features/bible-knowledge-layer.md, "Localized
// labels"; design doc §8.3):
//   • the project's own agreed rendering wins when terminology has one:
//     preferred, else admitted, and a forbidden rendering is never shown;
//   • only an active concept that names the person as a whole counts, and a
//     termbase shared by several lanes is used only when it is unambiguous;
//   • otherwise the interface language, then English, with the step that
//     answered always reported, so the popover can say where a name came from.

import { describe, expect, it } from "vitest"
import type { Concept } from "@/lib/terminology/types"
import { JESUS, SAMARITAN_WOMAN, jhn4People } from "./__fixtures__/jhn4"
import {
  acaiLanguageFor,
  acaiLanguageForLocale,
  agreedRendering,
  resolveVoiceLabel,
  type ProjectNameSource,
  type VoiceLabelOptions,
} from "./voice-labels"

const people = jhn4People()
const jesus = people.entities[JESUS]
const woman = people.entities[SAMARITAN_WOMAN]

function concept(
  sourceTerm: string,
  renderings: Concept["renderings"],
  status: Concept["status"] = "active",
): Concept {
  return { id: `c-${sourceTerm}-${renderings.length}`, sourceTerm, renderings, status, createdAt: "2026-10-05T00:00:00Z" }
}

function options(overrides: Partial<VoiceLabelOptions> & { names?: Partial<ProjectNameSource> } = {}): VoiceLabelOptions {
  const { names, ...rest } = overrides
  return {
    mode: "project",
    interfaceLanguage: acaiLanguageForLocale("fr"),
    projectNames: { concepts: [], sourceLanguage: "eng", multiLane: false, ...names },
    ...rest,
  }
}

describe("project names (terminology)", () => {
  it("uses the project's preferred rendering, and says so", () => {
    const concepts = [concept("Jesus", [{ rendering: "Yesus", status: "preferred" }])]
    expect(resolveVoiceLabel(JESUS, jesus, options({ names: { concepts } }))).toEqual({
      label: "Yesus",
      source: "terminology",
    })
  })

  it("prefers a preferred rendering to an admitted one, and uses admitted when that is all there is", () => {
    const both = [
      concept("Jesus", [
        { rendering: "Isa", status: "admitted" },
        { rendering: "Yesus", status: "preferred" },
      ]),
    ]
    expect(resolveVoiceLabel(JESUS, jesus, options({ names: { concepts: both } }))?.label).toBe("Yesus")

    const admittedOnly = [concept("Jesus", [{ rendering: "Isa", status: "admitted" }])]
    expect(resolveVoiceLabel(JESUS, jesus, options({ names: { concepts: admittedOnly } }))?.label).toBe("Isa")
  })

  it("never shows a forbidden rendering, even one another entry prefers", () => {
    const forbiddenOnly = [concept("Jesus", [{ rendering: "Isa Almasih", status: "forbidden" }])]
    // Nothing agreed: the interface language answers instead (French UI).
    expect(resolveVoiceLabel(JESUS, jesus, options({ names: { concepts: forbiddenOnly } }))).toEqual({
      label: "Jésus",
      source: "acai",
    })

    const conflicting = [
      concept("Jesus", [{ rendering: "Isa", status: "preferred" }]),
      concept("Jesus", [{ rendering: "Isa", status: "forbidden" }]),
    ]
    expect(agreedRendering(conflicting, false)).toBeNull()
  })

  it("ignores draft and deprecated entries", () => {
    const drafts = [
      concept("Jesus", [{ rendering: "Yesus", status: "preferred" }], "draft"),
      concept("Jesus", [{ rendering: "Yesua", status: "preferred" }], "deprecated"),
    ]
    expect(resolveVoiceLabel(JESUS, jesus, options({ names: { concepts: drafts } }))?.source).toBe("acai")
  })

  it("needs the entry to name the person as a whole, not just part of the name", () => {
    const samaritans = [concept("Samaritan", [{ rendering: "orang Samaria", status: "preferred" }])]
    expect(resolveVoiceLabel(SAMARITAN_WOMAN, woman, options({ names: { concepts: samaritans } }))?.source).not.toBe(
      "terminology",
    )

    // An entry for the whole descriptive label is the project's rendering of it.
    const whole = [concept("Samaritan woman", [{ rendering: "perempuan Samaria", status: "preferred" }])]
    expect(resolveVoiceLabel(SAMARITAN_WOMAN, woman, options({ names: { concepts: whole } }))).toEqual({
      label: "perempuan Samaria",
      source: "terminology",
    })
  })

  it("matches through the entry's listed forms, case and accents aside", () => {
    const concepts = [
      { ...concept("Jésus-Christ", [{ rendering: "Yesus", status: "preferred" }]), match: { forms: ["JÉSUS"] } },
    ]
    const frenchSource = options({ names: { concepts, sourceLanguage: "fra" } })
    expect(resolveVoiceLabel(JESUS, jesus, frenchSource)?.label).toBe("Yesus")
  })

  it("uses a shared termbase in a multi-lane project only when it gives one answer", () => {
    const ambiguous = [
      concept("Jesus", [
        { rendering: "Yesus", status: "preferred" },
        { rendering: "Isa", status: "preferred" },
      ]),
    ]
    expect(resolveVoiceLabel(JESUS, jesus, options({ names: { concepts: ambiguous, multiLane: true } }))?.source).toBe(
      "acai",
    )
    // One lane: the first preferred rendering is the project's choice.
    expect(resolveVoiceLabel(JESUS, jesus, options({ names: { concepts: ambiguous } }))?.label).toBe("Yesus")

    const single = [concept("Jesus", [{ rendering: "Yesus", status: "preferred" }])]
    expect(resolveVoiceLabel(JESUS, jesus, options({ names: { concepts: single, multiLane: true } }))?.label).toBe(
      "Yesus",
    )
  })

  it("has no project-name step when the pack has no labels in the source language (Greek)", () => {
    const concepts = [concept("Ἰησοῦς", [{ rendering: "Yesus", status: "preferred" }])]
    const greek = options({ names: { concepts, sourceLanguage: acaiLanguageFor("grc") } })
    expect(resolveVoiceLabel(JESUS, jesus, greek)?.source).toBe("acai")
  })

  it("takes a concept linked to the entity first, through the typed hook", () => {
    const linked = concept("Yeshua", [{ rendering: "Yesua", status: "preferred" }])
    const result = resolveVoiceLabel(
      JESUS,
      jesus,
      options({ names: { conceptsForEntity: (id) => (id === JESUS ? [linked] : []) } }),
    )
    expect(result).toEqual({ label: "Yesua", source: "terminology" })
  })
})

describe("interface language, then English", () => {
  const withRendering = { concepts: [concept("Jesus", [{ rendering: "Yesus", status: "preferred" }])] }

  it("skips project names when the person chose the interface language", () => {
    expect(resolveVoiceLabel(JESUS, jesus, options({ mode: "interface", names: withRendering }))).toEqual({
      label: "Jésus",
      source: "acai",
    })
  })

  it("falls back to English for an interface language ACAI has no labels in (Thai, Malay, Burmese)", () => {
    for (const locale of ["th", "ms", "my"]) {
      expect(acaiLanguageForLocale(locale)).toBeNull()
      const result = resolveVoiceLabel(JESUS, jesus, options({ mode: "interface", interfaceLanguage: null }))
      expect(result).toEqual({ label: "Jesus", source: "english" })
    }
  })

  it("is English only when the person chose English, terminology and interface aside", () => {
    expect(resolveVoiceLabel(JESUS, jesus, options({ mode: "english", names: withRendering }))).toEqual({
      label: "Jesus",
      source: "english",
    })
  })

  it("reports the pack's own names as generated, not as ACAI's", () => {
    // The Samaritan woman is unnamed; "Samaritan woman" comes from a character id.
    expect(resolveVoiceLabel(SAMARITAN_WOMAN, woman, options({ interfaceLanguage: acaiLanguageForLocale("en") }))).toEqual(
      { label: "Samaritan woman", source: "generated" },
    )
    // A French interface has no French label for her: still the generated English one.
    expect(resolveVoiceLabel(SAMARITAN_WOMAN, woman, options())).toEqual({
      label: "Samaritan woman",
      source: "generated",
    })
  })

  it("flags ACAI's Traditional-character Chinese labels for a Simplified interface", () => {
    expect(resolveVoiceLabel(JESUS, jesus, options({ mode: "interface", interfaceLanguage: acaiLanguageForLocale("zh-Hans") }))).toEqual({
      label: "耶穌",
      source: "acai",
      otherScript: true,
    })
    expect(resolveVoiceLabel(JESUS, jesus, options({ mode: "interface", interfaceLanguage: acaiLanguageForLocale("zh-Hant") }))).toEqual({
      label: "耶穌",
      source: "acai",
    })
  })

  it("has no name for an entity the people layer lacks", () => {
    expect(resolveVoiceLabel("person:Nobody", undefined, options())).toBeNull()
  })
})

describe("language codes", () => {
  it("maps project and interface codes onto ACAI's label languages", () => {
    expect(acaiLanguageFor("en")).toBe("eng")
    expect(acaiLanguageFor("eng")).toBe("eng")
    expect(acaiLanguageFor("English")).toBe("eng")
    expect(acaiLanguageFor("fr-CA")).toBe("fra")
    expect(acaiLanguageFor("id")).toBe("ind")
    expect(acaiLanguageFor("ar")).toBe("arb")
    expect(acaiLanguageFor("zh-Hant")).toBe("cmn")
    expect(acaiLanguageFor("sw")).toBe("swh")
    expect(acaiLanguageFor("ha")).toBe("hau")
    expect(acaiLanguageFor("tpi")).toBe("tpi")
    expect(acaiLanguageFor("grc")).toBeNull()
    expect(acaiLanguageFor("ms")).toBeNull()
    expect(acaiLanguageFor(undefined)).toBeNull()
  })
})
