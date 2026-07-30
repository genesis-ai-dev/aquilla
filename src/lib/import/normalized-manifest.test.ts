import { describe, expect, it } from "vitest"
import { usfmSectionToStrings } from "@/lib/parsers/parse-text-formats"
import type { TranslatableString } from "@/lib/parsers/types"
import {
  aquillaImportMetadata,
  normalizeTranslatableStrings,
  summarizeNormalizedImport,
} from "./normalized-manifest"

describe("normalized import manifest", () => {
  it("keeps in-body Scripture headings unnumbered without shifting canonical verse labels", () => {
    const raw = [
      "\\id GEN",
      "\\mt1 Genesis",
      "\\c 1",
      "\\s1 The beginning",
      "\\p",
      "\\v 1 In the beginning God created the heavens and the earth.",
      "\\v 2 Now the earth was formless and empty.",
      "\\v 3-4 A verse bridge.",
    ].join("\n")
    const parsed = usfmSectionToStrings(raw)

    const manifest = normalizeTranslatableStrings(parsed.strings, {
      fileName: "01GEN.SFM",
      fileType: "usfm",
      profileId: "builtin:paratext-usfm",
      profileVersion: "1",
    })

    expect(manifest.units.map((unit) => ({
      kind: unit.kind,
      label: unit.displayLabel,
      ref: unit.canonicalRef,
    }))).toEqual([
      { kind: "heading", label: null, ref: "GEN 1:s1:1" },
      { kind: "verse", label: "1", ref: "GEN 1:1" },
      { kind: "verse", label: "2", ref: "GEN 1:2" },
      { kind: "verse", label: "3-4", ref: "GEN 1:3-4" },
    ])
    expect(manifest.units.map((unit) => unit.unitKey)).toEqual([
      "scripture-structure:GEN 1:s1:1",
      "scripture:GEN 1:1",
      "scripture:GEN 1:2",
      "scripture:GEN 1:3-4",
    ])
    expect(manifest.warnings).toEqual([])
  })

  it("does not number a heading merely because an inferred parser attached a nearby verse reference", () => {
    const manifest = normalizeTranslatableStrings([{
      id: "heading",
      original: "The beginning",
      translated: "",
      context: "GEN 1:1",
      group: "GEN 1:1",
      globalReferences: ["GEN 1:1"],
      type: "heading",
    }, {
      id: "verse",
      original: "In the beginning",
      translated: "",
      context: "GEN 1:1",
      group: "GEN 1:1",
      globalReferences: ["GEN 1:1"],
      type: "verse",
    }], { fileName: "custom", fileType: "custom" })

    expect(manifest.units[0]).toMatchObject({ kind: "heading", displayLabel: null })
    expect(manifest.units[0].canonicalRef).toBeUndefined()
    expect(manifest.units[0].address).toEqual({ scheme: "sequence", index: 1 })
    expect(manifest.units[1]).toMatchObject({
      kind: "verse",
      displayLabel: "1",
      canonicalRef: "GEN 1:1",
      address: { scheme: "scripture", book: "GEN", chapter: 1, verse: "1" },
    })
  })

  it("preserves package locations and disambiguates split segments in one block", () => {
    const strings: TranslatableString[] = [
      {
        id: "a",
        original: "First sentence.",
        translated: "",
        context: "Paragraph",
        group: "paragraph-1",
        type: "text",
        sourceLocation: { file: "word/document.xml", blockPath: "w:p[4]" },
        paragraphStart: true,
      },
      {
        id: "b",
        original: "Second sentence.",
        translated: "",
        context: "Paragraph",
        group: "paragraph-1",
        type: "text",
        sourceLocation: { file: "word/document.xml", blockPath: "w:p[4]" },
      },
    ]

    const manifest = normalizeTranslatableStrings(strings, {
      fileName: "notes.docx",
      fileType: "docx",
    })

    expect(manifest.units.map((unit) => unit.unitKey)).toEqual([
      "document:word/document.xml:w:p[4]:1",
      "document:word/document.xml:w:p[4]:2",
    ])
    expect(manifest.units[0].address).toEqual({
      scheme: "document",
      memberPath: "word/document.xml",
      blockPath: "w:p[4]",
      segment: 1,
    })
    expect(manifest.units[1].sourceLocator).toEqual({
      kind: "package-block",
      memberPath: "word/document.xml",
      blockPath: "w:p[4]",
      segment: 2,
    })
  })

  it("preserves the exact IDML v2 locator and protected source/target HTML", () => {
    const locator = {
      kind: "idml" as const,
      memberPath: "Stories/Story_u1.xml",
      storyId: "u1",
      elementPath: "/Story/ParagraphStyleRange[1]",
      elementId: "p1",
      scope: "story-paragraph" as const,
      part: 0,
      slotIndexes: [0, 1],
      sourceBlockHash: "a".repeat(64),
    }
    const sourceHtml = '<p data-idml-version="2"><span data-idml-slot="0">Source</span></p>'
    const targetHtml = '<p data-idml-version="2"><span data-idml-slot="0"></span></p>'
    const manifest = normalizeTranslatableStrings([{
      id: "idml-unit",
      original: "Source",
      originalHtml: sourceHtml,
      translated: "",
      translatedHtml: targetHtml,
      context: "Paragraph",
      group: "story",
      type: "text",
      sourceLocator: locator,
      metadata: { idml: { version: 2 } },
    }], {
      fileName: "layout.idml",
      fileType: "idml",
      profileId: "builtin:idml-roundtrip",
      profileVersion: "2",
    })

    expect(manifest).toMatchObject({
      profileId: "builtin:idml-roundtrip",
      profileVersion: "2",
      fidelity: "content-only",
    })
    expect(manifest.units[0]).toMatchObject({
      unitKey: `idml:${locator.memberPath}:${locator.elementPath}:0`,
      address: {
        scheme: "document",
        memberPath: locator.memberPath,
        blockPath: locator.elementPath,
        segment: 1,
      },
      sourceLocator: locator,
      sourceHtml,
      targetHtml,
      metadata: { idml: { version: 2 } },
    })
  })

  it("uses timing and cue order as subtitle identity while retaining speakers", () => {
    const strings: TranslatableString[] = [{
      id: "cue-random-id",
      original: "Hello there",
      translated: "Bonjour",
      context: "00:00:01.000 --> 00:00:03.500",
      group: "random-group",
      type: "cue",
      start: 1,
      end: 3.5,
      speaker: "Mary",
    }]

    const manifest = normalizeTranslatableStrings(strings, {
      fileName: "episode.vtt",
      fileType: "vtt",
    })

    expect(manifest.units[0]).toMatchObject({
      unitKey: "cue:00:00:01.000 --> 00:00:03.500",
      kind: "cue",
      displayLabel: "1",
      address: { scheme: "timeline", cue: 1, startMs: 1000, endMs: 3500 },
      sourceLocator: { kind: "cue", index: 1, startMs: 1000, endMs: 3500 },
      targetText: "Bonjour",
      speaker: "Mary",
    })
  })

  it("warns instead of silently accepting duplicate verse references or invalid timing", () => {
    const verse = (id: string): TranslatableString => ({
      id,
      original: id,
      translated: "",
      context: "GEN 1:1",
      group: "GEN 1:1",
      globalReferences: ["GEN 1:1"],
      type: "verse",
    })
    const cue: TranslatableString = {
      id: "cue",
      original: "bad timing",
      translated: "",
      context: "bad",
      group: "bad",
      type: "cue",
      start: 3,
      end: 2,
    }

    const scripture = normalizeTranslatableStrings([verse("first"), verse("second")], {
      fileName: "GEN.usfm",
      fileType: "usfm",
    })
    const subtitles = normalizeTranslatableStrings([cue], {
      fileName: "bad.vtt",
      fileType: "vtt",
    })

    expect(scripture.units.map((unit) => unit.unitKey)).toEqual([
      "scripture:GEN 1:1",
      "scripture:GEN 1:1#2",
    ])
    expect(scripture.warnings.map((warning) => warning.code)).toContain("duplicate-canonical-ref")
    expect(subtitles.warnings.map((warning) => warning.code)).toContain("invalid-timing")
  })

  it("creates a compact versioned metadata envelope for cell persistence", () => {
    const manifest = normalizeTranslatableStrings([{
      id: "one",
      original: "Text",
      translated: "",
      context: "GEN 1:1",
      group: "GEN 1:1",
      globalReferences: ["GEN 1:1"],
      type: "verse",
    }], {
      fileName: "GEN.usfm",
      fileType: "usfm",
      profileId: "builtin:paratext-usfm",
      profileVersion: "2026-07-20",
    })

    expect(aquillaImportMetadata(manifest, manifest.units[0])).toEqual({
      version: 1,
      profileId: "builtin:paratext-usfm",
      profileVersion: "2026-07-20",
      unitKey: "scripture:GEN 1:1",
      kind: "verse",
      displayLabel: "1",
      milestone: {
        key: "scripture:GEN:1",
        kind: "chapter",
        label: "Genesis 1",
        shortLabel: "1",
      },
      address: { scheme: "scripture", book: "GEN", chapter: 1, verse: "1" },
      sourceLocator: { kind: "usfm", ref: "GEN 1:1", marker: "v" },
      physicalOrder: 0,
      fidelity: "native",
    })
    expect(summarizeNormalizedImport(manifest)).toEqual({
      version: 1,
      profileId: "builtin:paratext-usfm",
      profileVersion: "2026-07-20",
      deterministic: true,
      fidelity: "native",
      unitCount: 1,
      warningCounts: {},
      hasScriptureContent: true,
    })
  })

  it("persists a reviewed custom recipe and stable record locators", () => {
    const recipe = {
      version: 1 as const,
      id: "ai-recipe-1",
      name: "Pipe records",
      inputFormat: "legacy-text",
      strategy: "records" as const,
      config: { recordMode: "delimited", delimiter: "|" },
      proposedBy: "ai" as const,
    }
    const manifest = normalizeTranslatableStrings([{
      id: "one",
      original: "Heading",
      translated: "Titre",
      context: "Record 4",
      group: "record-4",
      type: "heading",
      metadata: { aquillaRecipe: { recipeId: recipe.id, record: 4, field: "source" } },
    }], {
      fileName: "legacy.weird",
      fileType: "custom",
      profileId: `agentic:${recipe.id}`,
      deterministic: false,
      fidelity: "content-only",
      recipe,
    })

    expect(manifest.units[0]).toMatchObject({
      unitKey: "custom:ai-recipe-1:4",
      displayLabel: null,
      address: { scheme: "custom", recipeId: "ai-recipe-1", record: 4 },
      sourceLocator: { kind: "recipe", recipeId: "ai-recipe-1", record: 4, field: "source" },
    })
    expect(summarizeNormalizedImport(manifest)).toMatchObject({
      deterministic: false,
      fidelity: "content-only",
      recipe,
    })
  })

  it("keeps recipe-parsed headings in their Scripture chapter without treating them as verses", () => {
    const manifest = normalizeTranslatableStrings([{
      id: "heading",
      original: "The beginning",
      translated: "",
      context: "GEN 1:1",
      group: "GEN 1:h:1",
      section: "GEN 1",
      globalReferences: ["GEN 1:h:1"],
      type: "heading",
      metadata: { aquillaRecipe: { recipeId: "sandbox-parser", record: 1 } },
    }], {
      fileName: "legacy.odd",
      fileType: "custom",
    })

    expect(manifest.units[0]).toMatchObject({
      canonicalRef: "GEN 1:h:1",
      displayLabel: null,
      address: {
        scheme: "scripture-structure",
        book: "GEN",
        chapter: 1,
        marker: "h",
        occurrence: 1,
      },
      sourceLocator: { kind: "recipe", recipeId: "sandbox-parser", record: 1 },
    })
    expect(summarizeNormalizedImport(manifest)).toMatchObject({ hasScriptureContent: true })
  })

  it("keeps sequence identities stable when a parser regenerates group ids", () => {
    const parse = (headingGroup: string, paragraphGroup: string, suffix: string) =>
      normalizeTranslatableStrings([
        {
          id: `heading-${suffix}`,
          original: `Heading ${suffix}`,
          translated: "",
          context: "Heading 1",
          group: headingGroup,
          type: "heading",
        },
        {
          id: `paragraph-${suffix}`,
          original: `Paragraph ${suffix}`,
          translated: "",
          context: "Paragraph",
          group: paragraphGroup,
          type: "text",
          paragraphStart: true,
        },
      ] satisfies TranslatableString[], {
        fileName: "notes.md",
        fileType: "md",
      })

    const first = parse(crypto.randomUUID(), crypto.randomUUID(), "before")
    const second = parse(crypto.randomUUID(), crypto.randomUUID(), "after")

    expect(first.units.map((unit) => unit.unitKey)).toEqual([
      "sequence:Heading 1",
      "sequence:Paragraph",
    ])
    expect(first.units.map((unit) => unit.canonicalRef)).toEqual([undefined, undefined])
    expect(first.units.map((unit) => unit.displayLabel)).toEqual([null, "1"])
    expect(second.units.map((unit) => unit.unitKey)).toEqual(
      first.units.map((unit) => unit.unitKey),
    )
  })
})
