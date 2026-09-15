/**
 * AQU-1174: Biblica's English "source serif" apostrophe glue must never ride
 * into a translated cell.
 *
 * The composition tests below run the real importer's output through the real
 * AI-draft normalizer, because the bug lives in that join: the importer marks
 * the glue run as an ordinary editable slot (it has to — its span is part of
 * the protected anchor sequence), and the model then copies the apostrophe
 * straight through into the target.
 */

import { describe, expect, it } from "vitest"
import { parseIdml, type IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import {
  biblicaFrontBackMatterStory,
  makeBiblicaIdml,
  paragraph,
  run,
} from "@/lib/biblica/__fixtures__/biblica-idml"
import { extractBiblicaStudyNoteStrings } from "@/lib/parsers/biblica"
import { normalizeProtectedCompletion } from "@/lib/idml/completion"
import type { TranslatableString } from "@/lib/parsers/types"
import {
  biblicaApostropheGlueSlots,
  clearBiblicaApostropheGlue,
  isBiblicaBookVolumeCell,
} from "./apostrophe-glue"

const PLAIN = "$ID/[No character style]"
const GLUE = "ʼ"

/** A book-volume note whose English possessive is set as a separate run. */
const BOOK_VOLUME_STORY = [
  paragraph("p-bk", "meta%3abk", run(PLAIN, "GEN")),
  paragraph(
    "p-n",
    "intro%3aip",
    run(PLAIN, "Israel")
      + run("source%20serif", GLUE)
      + run(PLAIN, "s covenant history begins here."),
  ),
]

async function importCells(
  story?: readonly string[],
): Promise<{ strings: TranslatableString[]; frontBackMatter: boolean }> {
  const bytes = await makeBiblicaIdml(story)
  const parsed = await parseIdml(bytes.slice(0))
  const { strings, frontBackMatter } = await extractBiblicaStudyNoteStrings(
    bytes.slice(0),
    async () => parsed,
    {},
  )
  return { strings, frontBackMatter }
}

/** The draft a model returns: every slot's source text, copied or translated. */
function draftFrom(sourceHtml: string, translate: (text: string) => string): string {
  const container = document.createElement("div")
  container.innerHTML = sourceHtml
  for (const slot of container.querySelectorAll<HTMLElement>("span[data-idml-slot]")) {
    slot.textContent = translate(slot.textContent ?? "")
  }
  return container.firstElementChild!.outerHTML
}

function idmlMetadataOf(cell: TranslatableString): IdmlFormatMetadataV2 {
  return (cell.metadata as { idml: IdmlFormatMetadataV2 }).idml
}

describe("Biblica apostrophe glue", () => {
  it("identifies the glue slot from the source character style", async () => {
    const { strings } = await importCells(BOOK_VOLUME_STORY)
    const cell = strings[0]!

    expect(isBiblicaBookVolumeCell(cell.metadata)).toBe(true)
    expect([...biblicaApostropheGlueSlots(cell.originalHtml!, idmlMetadataOf(cell))])
      .toEqual([1])
  })

  it("drops glue an AI draft copied into a book volume's target", async () => {
    const { strings } = await importCells(BOOK_VOLUME_STORY)
    const cell = strings[0]!
    // The model translates the prose and copies the punctuation-only slot.
    const drafted = draftFrom(
      cell.originalHtml!,
      (text) => text === GLUE ? GLUE : text.toUpperCase(),
    )

    const normalized = normalizeProtectedCompletion(
      { id: cell.id, originalHtml: cell.originalHtml, metadata: cell.metadata },
      drafted,
    )

    expect(normalized.value).not.toContain(GLUE)
    expect(normalized.valueHtml).not.toContain(GLUE)
    // The slot itself survives — only its text goes — so the protected anchor
    // sequence still matches the source package and the cell still exports.
    expect(normalized.valueHtml).toContain('data-idml-slot="1"')
    expect(normalized.value).toBe("ISRAELS COVENANT HISTORY BEGINS HERE.")
  })

  it("keeps a possessive apostrophe in a front/back matter volume", async () => {
    const { strings, frontBackMatter } = await importCells(biblicaFrontBackMatterStory)
    expect(frontBackMatter).toBe(true)
    const cell = strings.find((entry) => entry.original.includes(GLUE))
    expect(cell).toBeDefined()
    expect(isBiblicaBookVolumeCell(cell!.metadata)).toBe(false)

    const drafted = draftFrom(cell!.originalHtml!, (text) => text)
    const normalized = normalizeProtectedCompletion(
      { id: cell!.id, originalHtml: cell!.originalHtml, metadata: cell!.metadata },
      drafted,
    )

    // Prose-heavy front/back matter sets ordinary possessives in the same run,
    // so nothing is stripped there.
    expect(normalized.value).toBe(cell!.original)
  })

  it("keeps translated words a model put in a glue slot", async () => {
    const { strings } = await importCells(BOOK_VOLUME_STORY)
    const cell = strings[0]!
    const drafted = draftFrom(
      cell.originalHtml!,
      (text) => text === GLUE ? "चा" : text.toUpperCase(),
    )

    const normalized = normalizeProtectedCompletion(
      { id: cell.id, originalHtml: cell.originalHtml, metadata: cell.metadata },
      drafted,
    )

    expect(normalized.value).toContain("चा")
  })

  it("leaves a contributor's own apostrophe alone", async () => {
    const { strings } = await importCells(BOOK_VOLUME_STORY)
    const cell = strings[0]!
    // A real apostrophe typed inside a prose slot is target text, not glue.
    const drafted = draftFrom(
      cell.originalHtml!,
      (text) => text === GLUE ? GLUE : `${text.toUpperCase()}'S`,
    )

    const cleared = clearBiblicaApostropheGlue(
      cell.metadata,
      cell.originalHtml!,
      drafted,
      idmlMetadataOf(cell),
    )

    expect(cleared).toContain("'S")
    expect(cleared).not.toContain(GLUE)
  })

  it("leaves a non-Biblica IDML cell untouched", async () => {
    const { strings } = await importCells(BOOK_VOLUME_STORY)
    const cell = strings[0]!
    const drafted = draftFrom(cell.originalHtml!, (text) => text)

    expect(clearBiblicaApostropheGlue(
      { idml: idmlMetadataOf(cell) },
      cell.originalHtml!,
      drafted,
      idmlMetadataOf(cell),
    )).toBe(drafted)
  })
})
