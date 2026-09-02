// Biblica IDML import — carved out of src/lib/import.ts behind the
// partner-integrations seam so the public open-source build can exclude this
// whole module. It depends on the generic import primitives it was extracted
// from (emitParsedFile, the manifest normalizer, the IDML-package guard).
import type { IdmlProgress } from "@aquilla/idml-roundtrip"
import { t } from "@/lib/i18n/standalone"
import type { FileReference, TranslatableString } from "@/lib/parsers/types"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
import { normalizeTranslatableStrings } from "@/lib/import/normalized-manifest"
import {
  emitParsedFile,
  assertIdmlPackageBytes,
  BIBLICA_NOTES_PROFILE_ID,
  TREASURE_HUNT_PROFILE_ID,
  REACH4LIFE_PROFILE_ID,
  type ImportContext,
} from "@/lib/import"
import { extractBiblicaStudyNoteStrings } from "./parsers/biblica"
import { extractTreasureHuntStrings } from "./parsers/biblica-treasure-hunt"
import { extractReach4LifeStrings } from "./parsers/biblica-reach4life"

/**
 * Which Biblica title an IDML package is. Nothing in the package identifies the
 * edition, and the three templates disagree about what a paragraph style means,
 * so the person importing it says which one this is.
 */
export type BiblicaEdition = "study-notes" | "treasure-hunt" | "reach4life"

/**
 * Sidebar folder per edition, so a project holding more than one Biblica title
 * keeps them apart. The label is the file's corpus marker, which the sidebar
 * groups by and the user can rename or move a file out of later.
 */
const BIBLICA_CORPUS_MARKERS: Readonly<Record<BiblicaEdition, string>> = {
  "study-notes": "Biblica Study Notes",
  "treasure-hunt": "Treasure Hunt Bible",
  reach4life: "Reach 4 Life",
}

export type BiblicaImportPhase = "parse" | "save"
export interface BiblicaProgress {
  phase: BiblicaImportPhase
  /** Engine parse progress, while the package is being read. */
  idml?: IdmlProgress
  cellsEnqueued?: number
  cellsTotal?: number
  /** Paragraphs left out because they are scripture rather than notes. */
  verseUnitCount?: number
}

/**
 * Import the notes from a Biblica IDML package.
 *
 * The package parses through the same shared v2 engine as a plain IDML import,
 * so cells keep their protected anchors, exact locators, and preserved source
 * bytes — strict IDML export still works. Only the note paragraphs become cells:
 * the Bible text is set from the publisher's scripture files, so importing it
 * here would ask translators to retype scripture they must not edit.
 *
 * Which paragraphs count as notes depends on the edition. A study Bible marks
 * its notes positively (`intro:*`); the Treasure Hunt Bible and Reach4Life mark
 * scripture instead, so everything set around the Bible text is imported —
 * facts and hunts, lessons and journeys, book introductions and front matter.
 * See `@/lib/partner-integrations/biblica/treasure-hunt/notes` and `@/lib/partner-integrations/biblica/reach4life/notes`.
 *
 * The study Bible's own front and back matter — contents, "how to use", the
 * Bible Dictionary, the timelines, the maps, the cover — ships as separate
 * volumes holding no scripture at all, which is how the reader recognizes them
 * without another toggle. There every text-bearing paragraph is a cell.
 */
export interface BiblicaImportOptions {
  /**
   * When true, cut long note lines into one cell per sentence.
   * When false, each line stays a single cell (lists still split per line).
   */
  splitSentences?: boolean
  /** Which template's rules to read the package with. Defaults to a study Bible. */
  edition?: BiblicaEdition
}

export async function importBiblicaStudyNotes(
  file: File,
  ctx: ImportContext,
  onProgress?: (p: BiblicaProgress) => void,
  options?: BiblicaImportOptions,
): Promise<FileReference> {
  if (!/\.idml$/i.test(file.name)) {
    throw new Error(t("importExport.errors.biblicaExpectsIdml"))
  }
  assertSourceUploadByteLength(file.size)
  onProgress?.({ phase: "parse" })

  const edition: BiblicaEdition = options?.edition ?? "study-notes"
  // The worker transfers (detaches) its input, so the preserved source artifact
  // is read from the File a second time rather than shared with the parse buffer.
  const parseBuffer = await file.arrayBuffer()
  assertIdmlPackageBytes(parseBuffer, file.name)
  const parseOptions = {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    onProgress: (idml: IdmlProgress) => onProgress?.({ phase: "parse", idml }),
    ...(options?.splitSentences !== undefined
      ? { splitSentences: options.splitSentences }
      : {}),
  }
  const { strings, bookCodes, skippedScriptureCount, frontBackMatter } = await parseBiblicaEdition(
    edition,
    parseBuffer,
    parseOptions,
  )

  // A study-Bible volume that yields nothing was almost certainly read with the
  // wrong edition. A front/back matter volume that yields nothing is simply
  // artwork — the maps and plates hold no text — and still imports, so the file
  // stays part of the project and exports back unchanged.
  if (strings.length === 0 && !frontBackMatter) {
    throw new Error(emptyBiblicaImportMessage(edition, file.name))
  }

  const name = file.name.replace(/\.idml$/i, "").replace(/[-_]?notes$/i, "").trim() || file.name
  const normalized = normalizeTranslatableStrings(strings, {
    fileName: name,
    fileType: "idml",
    profileId: BIBLICA_PROFILE_IDS[edition],
    profileVersion: "1",
    fidelity: "content-only",
  })

  onProgress?.({
    phase: "save",
    cellsEnqueued: 0,
    cellsTotal: strings.length,
    verseUnitCount: skippedScriptureCount,
  })

  const { ref } = await emitParsedFile(
    {
      name,
      originalName: file.name,
      strings,
      rawBytes: await file.arrayBuffer(),
      rawSourceFormat: "idml",
      roundTripFidelity: "content-only",
      corpusMarker: BIBLICA_CORPUS_MARKERS[edition],
      ...(bookCodes.length === 1 ? { bookCode: bookCodes[0] } : {}),
    },
    "idml",
    {
      ...ctx,
      onCellEnqueued: (uploaded, total) => {
        ctx.onCellEnqueued?.(uploaded, total)
        onProgress?.({
          phase: "save",
          cellsEnqueued: uploaded,
          cellsTotal: total,
          verseUnitCount: skippedScriptureCount,
        })
      },
    },
    normalized,
  )
  return ref
}

const BIBLICA_PROFILE_IDS: Readonly<Record<BiblicaEdition, string>> = {
  "study-notes": BIBLICA_NOTES_PROFILE_ID,
  "treasure-hunt": TREASURE_HUNT_PROFILE_ID,
  reach4life: REACH4LIFE_PROFILE_ID,
}

interface BiblicaParseOutcome {
  strings: TranslatableString[]
  bookCodes: string[]
  /** Paragraphs left out because they are the published Bible text. */
  skippedScriptureCount: number
  /**
   * The package is one of the study Bible's front/back matter volumes — no
   * scripture anywhere, so an empty result is a legitimate artwork-only volume
   * rather than a package read with the wrong edition.
   */
  frontBackMatter: boolean
}

/**
 * Run the reader for one edition. Each returns the same three things under its
 * own names, because each counts a different thing as scripture.
 */
async function parseBiblicaEdition(
  edition: BiblicaEdition,
  buffer: ArrayBuffer,
  parseOptions: {
    signal?: AbortSignal
    onProgress: (progress: IdmlProgress) => void
    splitSentences?: boolean
  },
): Promise<BiblicaParseOutcome> {
  if (edition === "treasure-hunt") {
    const { strings, bookCodes, skipped } =
      await extractTreasureHuntStrings(buffer, undefined, parseOptions)
    return {
      strings,
      bookCodes,
      skippedScriptureCount: skipped.scriptureUnitCount,
      frontBackMatter: false,
    }
  }
  if (edition === "reach4life") {
    const { strings, bookCodes, skipped } =
      await extractReach4LifeStrings(buffer, undefined, parseOptions)
    return {
      strings,
      bookCodes,
      skippedScriptureCount: skipped.scriptureUnitCount,
      frontBackMatter: false,
    }
  }
  const { strings, bookCodes, skipped, frontBackMatter } =
    await extractBiblicaStudyNoteStrings(buffer, undefined, parseOptions)
  return {
    strings,
    bookCodes,
    skippedScriptureCount: skipped.verseUnitCount,
    frontBackMatter,
  }
}

/**
 * What to say when a package parsed but yielded nothing. The overwhelmingly
 * likely cause is the wrong edition, so each message names the styles it looked
 * for and — for the default reading — the toggles that change it.
 */
function emptyBiblicaImportMessage(edition: BiblicaEdition, fileName: string): string {
  if (edition === "treasure-hunt") {
    return `${fileName} parsed successfully but contained no Treasure Hunt notes. `
      + "Treasure Hunt content lives in `!meta_*`, `_intro_*` and front-matter paragraph "
      + "styles — check that this is a Treasure Hunt volume."
  }
  if (edition === "reach4life") {
    return `${fileName} parsed successfully but contained no Reach 4 Life content. `
      + "Reach 4 Life content lives in the `R4Lv4 Paragraph Styles:*` lesson groups and in "
      + "the `Metatext_BBI Bible Book Intros:*`, `Intros:*` and `Copyright:*` styles — check "
      + "that this is a Reach 4 Life package."
  }
  return `${fileName} parsed successfully but contained no study notes. `
    + "Biblica notes live in `intro:*` paragraph styles — check that this is the notes "
    + "document. If this is a Treasure Hunt Bible or a Reach 4 Life file, tick the matching "
    + "box and import it again."
}
