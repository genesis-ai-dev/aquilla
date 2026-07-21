import { describe, expect, it } from "vitest"
import { usfmSectionToStrings } from "@/lib/parsers/parse-text-formats"
import type { TranslatableString } from "@/lib/parsers/types"
import {
  aquillaImportMetadata,
  normalizeTranslatableStrings,
} from "./normalized-manifest"

describe("normalized import manifest", () => {
  it("keeps Scripture headings unnumbered without shifting canonical verse labels", () => {
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
      { kind: "paratext", label: null, ref: "GEN:mt1:1" },
      { kind: "heading", label: null, ref: "GEN 1:s1:1" },
      { kind: "verse", label: "1", ref: "GEN 1:1" },
      { kind: "verse", label: "2", ref: "GEN 1:2" },
      { kind: "verse", label: "3-4", ref: "GEN 1:3-4" },
    ])
    expect(manifest.units.map((unit) => unit.unitKey)).toEqual([
      "scripture-structure:GEN:mt1:1",
      "scripture-structure:GEN 1:s1:1",
      "scripture:GEN 1:1",
      "scripture:GEN 1:2",
      "scripture:GEN 1:3-4",
    ])
    expect(manifest.warnings).toEqual([])
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
      address: { scheme: "scripture", book: "GEN", chapter: 1, verse: "1" },
      sourceLocator: { kind: "usfm", ref: "GEN 1:1", marker: "v" },
      physicalOrder: 0,
      fidelity: "native",
    })
  })
})
