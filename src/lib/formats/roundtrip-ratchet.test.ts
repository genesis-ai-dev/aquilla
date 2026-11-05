// ONE round-trip ratchet for every format on the shared contract (AQU-2384).
//
// The per-format tests (`docx.roundtrip.test.ts`, `idml.roundtrip.test.ts`,
// `structured-roundtrip.test.ts`, `cat-roundtrip.test.ts`) prove each walk's
// own richness — tables, mixed runs, footnotes, cue timing. None of them
// proves the property they all share, which is the only thing a translator
// actually relies on:
//
//   1. Translate nothing, export, re-import → you get your file back.
//   2. Translate ONE line, export, re-import → exactly one line changed.
//
// Property 2 is the one that bites. Every mis-mapping bug this repo has had in
// a document exporter (AQU-1068's shifted paragraphs, the fused `<w:p/>`
// tokens) is a violation of it, and each was caught per-format, late, by a
// test written after the fact. This is that test written once, parameterised
// over the registry, so a format added to the table is covered the day it is
// added — `every registered format is on the ratchet` below is what makes
// that non-optional.
//
// What this does NOT assert is whole-file byte-identity. The payload formats
// rezip their container and re-serialize their markup, so the bytes differ
// while the content does not; making them byte-exact (encoding, BOM, line
// endings) is AQU-2383. `fidelity` on the descriptor is where that lands when
// it does, and the assertions here key off it rather than off a format name.

import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { parseIdml, exportIdml as exportIdmlEngine, validateExport } from "@aquilla/idml-roundtrip"
import type { CellData } from "@/hooks/useCells"
import type { TranslatableString } from "@/lib/parsers/core-types"
import { replaceProtectedIdmlText } from "@/lib/idml/protected-html"
import { createIdmlFilter } from "./filters/idml"
import type { FormatFilter, FormatSource } from "./contract"
import { FORMAT_DESCRIPTORS, descriptorById } from "./descriptors"
import { filterForFormatId } from "./registry"
import {
  HTML_FIXTURE,
  SRT_FIXTURE,
  VTT_FIXTURE,
  XLIFF_FIXTURE,
  docxFixture,
  idmlFixture,
  pptxFixture,
} from "./__fixtures__/ratchet-fixtures"

const CHANGED = "Delta"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The text of every unit, in parse order — the thing the ratchet compares. */
type Texts = readonly string[]

interface RatchetCase {
  readonly id: string
  readonly source: () => Promise<FormatSource>
  readonly filter: () => Promise<FormatFilter<CellData>>
  /**
   * Which field of a RE-PARSED unit holds what `build` was given.
   *
   * `original` for a monolingual output (a .docx of the translation is a
   * document in the target language; its paragraphs ARE the translation).
   * `translated` for a bilingual interchange file, where the source survives
   * beside the target. Getting this wrong is how a round-trip test passes
   * while asserting nothing, so it is stated per format rather than guessed.
   */
  readonly translationLandsIn: "original" | "translated"
  /** Cells for one build pass. Overridden only where a format needs more than
   *  the generic locator envelope (IDML's protected target html). */
  readonly cells?: (
    units: readonly TranslatableString[],
    translationFor: (unit: TranslatableString, index: number) => string,
  ) => CellData[]
}

/**
 * The generic import envelope: the locator the parser emitted, carried the way
 * `aquillaImportMetadata` carries it on a real import, so the package
 * exporters take their locator path and not their legacy positional fallback.
 */
function genericCells(
  units: readonly TranslatableString[],
  translationFor: (unit: TranslatableString, index: number) => string,
): CellData[] {
  return units.map((unit, index): CellData => {
    const translated = translationFor(unit, index)
    return {
      id: unit.id,
      fileId: "ratchet",
      original: unit.original,
      ...(unit.originalHtml !== undefined ? { originalHtml: unit.originalHtml } : {}),
      translated,
      translatedHtml: translated,
      context: unit.context,
      group: unit.group,
      type: unit.type,
      status: translated.trim() ? "unvalidated" : "empty",
      validationStatus: translated.trim() ? "none" : "empty",
      activeValidators: [],
      validationHistory: [],
      history: [],
      threads: [],
      metadata: {
        // MERGE, never replace: a parser that puts its own format contract on
        // the unit (IDML's v2 metadata) needs it to survive onto the cell, the
        // same way the real import envelope sits alongside it rather than over
        // it. Replacing this is how the IDML export loses its locator.
        ...(unit.metadata ?? {}),
        aquillaImport: {
          ...(isRecord(unit.metadata?.aquillaImport) ? unit.metadata.aquillaImport : {}),
          ...(unit.sourceLocator !== undefined ? { sourceLocator: unit.sourceLocator } : {}),
          physicalOrder: index,
        },
      },
      ...(unit.start !== undefined ? { startTime: unit.start } : {}),
      ...(unit.end !== undefined ? { endTime: unit.end } : {}),
      ...(unit.speaker !== undefined ? { speaker: unit.speaker } : {}),
    }
  })
}

/**
 * IDML cells additionally carry the protected target contract: the engine
 * refuses to export a translation whose slot structure does not prove against
 * the source, so a plain string in `translatedHtml` is rejected by design.
 * The identity pass therefore starts the target as the SOURCE html and edits
 * one slot through the same helper the editor's find/replace uses.
 */
function idmlCells(
  units: readonly TranslatableString[],
  translationFor: (unit: TranslatableString, index: number) => string,
): CellData[] {
  return genericCells(units, (unit) => unit.original).map((cell, index): CellData => {
    const unit = units[index]
    const identity: CellData = { ...cell, translatedHtml: unit.originalHtml ?? cell.translatedHtml }
    const wanted = translationFor(unit, index)
    if (wanted === unit.original) return identity
    const snapshot = replaceProtectedIdmlText(identity, unit.original, wanted)
    return { ...identity, translated: snapshot.value, translatedHtml: snapshot.valueHtml }
  })
}

const idmlEngineFilter = (): Promise<FormatFilter<CellData>> =>
  Promise.resolve(
    createIdmlFilter({
      // The engine's Web Worker does not exist under vitest, so the ratchet
      // drives the real engine in-process. Same code, no worker hop.
      parse: async (bytes) => parseIdml(bytes),
      executor: {
        parse: async (bytes) => parseIdml(bytes),
        export: (bytes, translations) => exportIdmlEngine(bytes, translations, { strict: true }),
        validate: (bytes, manifest) => validateExport(bytes, manifest),
      },
    }),
  )

const registered = async (id: string): Promise<FormatFilter<CellData>> => {
  const filter = await filterForFormatId(id)
  if (!filter) throw new Error(`no filter registered for "${id}"`)
  return filter
}

const text = (value: string): (() => Promise<FormatSource>) =>
  () => Promise.resolve({ kind: "text", text: value })
const bytes = (make: () => Promise<ArrayBuffer>): (() => Promise<FormatSource>) =>
  async () => ({ kind: "bytes", bytes: await make() })

const CASES: readonly RatchetCase[] = [
  {
    id: "docx",
    source: bytes(docxFixture),
    filter: () => registered("docx"),
    translationLandsIn: "original",
  },
  {
    id: "pptx",
    source: bytes(pptxFixture),
    filter: () => registered("pptx"),
    translationLandsIn: "original",
  },
  {
    id: "idml",
    source: bytes(idmlFixture),
    filter: idmlEngineFilter,
    translationLandsIn: "original",
    cells: idmlCells,
  },
  {
    id: "html",
    source: text(HTML_FIXTURE),
    filter: () => registered("html"),
    translationLandsIn: "original",
  },
  {
    id: "xliff",
    source: text(XLIFF_FIXTURE),
    filter: () => registered("xliff"),
    // XLIFF is the one bilingual output here: <source> survives, <target>
    // carries the translation.
    translationLandsIn: "translated",
  },
  {
    id: "srt",
    source: text(SRT_FIXTURE),
    filter: () => registered("srt"),
    translationLandsIn: "original",
  },
  {
    id: "vtt",
    source: text(VTT_FIXTURE),
    filter: () => registered("vtt"),
    translationLandsIn: "original",
  },
]

const textsOf = (units: readonly TranslatableString[], field: "original" | "translated"): Texts =>
  units.map((unit) => (field === "original" ? unit.original : unit.translated).trim())

/** Re-parse what `build` produced, through the same filter. */
async function reparse(
  filter: FormatFilter<CellData>,
  built: Uint8Array,
  source: FormatSource,
): Promise<readonly TranslatableString[]> {
  const copy = built.slice()
  const next: FormatSource = source.kind === "bytes"
    ? { kind: "bytes", bytes: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer }
    : { kind: "text", text: new TextDecoder().decode(copy) }
  return (await filter.parse(next)).units
}

it("every registered format is on the ratchet", () => {
  // The whole point of one shared test: wrapping a format onto the contract
  // without covering it here should fail, not pass quietly.
  expect(CASES.map((c) => c.id).sort()).toEqual(FORMAT_DESCRIPTORS.map((d) => d.id).sort())
})

describe.each(CASES)("round-trip ratchet: $id", (ratchet) => {
  const cellsFor = ratchet.cells ?? genericCells

  it("translate nothing, export, re-import → the same units come back", async () => {
    const source = await ratchet.source()
    const filter = await ratchet.filter()
    const first = await filter.parse(source)
    expect(first.units.length).toBeGreaterThan(0)

    // "No changes" means every unit's translation IS its source text, not an
    // empty target: an empty target is a different document (and the IDML
    // engine rightly refuses to call it an export at all).
    const built = await filter.build(first.skeleton, cellsFor(first.units, (unit) => unit.original))
    expect(built.unplaced).toEqual([])

    const after = await reparse(filter, built.bytes, source)
    expect(textsOf(after, "original")).toEqual(textsOf(first.units, "original"))
  })

  it("translate ONE unit, export, re-import → exactly that unit changed", async () => {
    const source = await ratchet.source()
    const filter = await ratchet.filter()
    const first = await filter.parse(source)
    // The middle unit: a mis-mapping that shifts by one shows up on both sides.
    const target = Math.floor(first.units.length / 2)

    const built = await filter.build(
      first.skeleton,
      cellsFor(first.units, (unit, index) => (index === target ? CHANGED : unit.original)),
    )
    expect(built.unplaced).toEqual([])

    const after = await reparse(filter, built.bytes, source)
    const landed = textsOf(after, ratchet.translationLandsIn)
    const before = textsOf(first.units, "original")

    expect(landed.length).toBe(before.length)
    expect(landed[target]).toBe(CHANGED)
    landed.forEach((value, index) => {
      if (index === target) return
      expect(value, `unit ${index} of ${ratchet.id} must not have changed`).toBe(before[index])
    })
  })

  it("a payload format leaves every part it did not translate byte-identical", async () => {
    const descriptor = descriptorById(ratchet.id)!
    if (descriptor.fidelity !== "payload") return
    const source = await ratchet.source()
    if (source.kind !== "bytes") return // html: no package members to compare

    const filter = await ratchet.filter()
    const first = await filter.parse(source)
    const built = await filter.build(first.skeleton, cellsFor(first.units, (unit) => unit.original))

    const before = await JSZip.loadAsync(await ratchet.source().then((s) => (s as { bytes: ArrayBuffer }).bytes))
    const after = await JSZip.loadAsync(built.bytes.slice())
    // Content parts are rewritten (byte-identically or not — that is AQU-2383);
    // everything ELSE in the package must survive untouched, which is what a
    // designer's styles, fonts and images depend on.
    const contentish = /document\.xml$|slide\d+\.xml$|^Stories\//
    const names = Object.keys(before.files).filter((n) => !before.files[n].dir && !contentish.test(n))
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const part = after.file(name)
      expect(part, `${name} is missing from the exported ${ratchet.id}`).toBeTruthy()
      expect(await part!.async("uint8array"), `${name} changed`).toEqual(
        await before.file(name)!.async("uint8array"),
      )
    }
  })
})
