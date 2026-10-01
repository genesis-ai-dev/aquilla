/**
 * The Biblica importer's public face (AQU-1286).
 *
 * This used to be `importBiblicaStudyNotes` in `src/lib/import.ts`, with four
 * static parser imports and an `if (edition === …)` chain, so deleting the
 * Biblica folder broke the typecheck. The generic half of that function is now
 * `importPartnerNotes`; what is left here is the part that is actually Biblica's
 * — which template to read the package with, and the fact that a Biblica package
 * is always IDML.
 *
 * The signature is unchanged, so every existing caller and test reads the same.
 */

import { importPartnerNotes, type ImportContext } from "@/lib/import"
import { t } from "@/lib/i18n/standalone"
import type { FileReference } from "@/lib/parsers/types"
import type { PartnerImportProgress } from "@/lib/partners/types"
import { BIBLICA_EDITIONS, type BiblicaEdition } from "./editions"

// The `builtin:*` profile ids are part of this module's public face: callers and
// tests that stamp or assert a Biblica file's profile read them from here.
export {
  BIBLICA_NOTES_PROFILE_ID,
  TREASURE_HUNT_PROFILE_ID,
  REACH4LIFE_PROFILE_ID,
  EBL_PROFILE_ID,
} from "./editions"
export type { BiblicaEdition } from "./editions"

export type BiblicaImportPhase = PartnerImportProgress["phase"]
export type BiblicaProgress = PartnerImportProgress

export interface BiblicaImportOptions {
  /**
   * When true, cut long note lines into one cell per sentence.
   * When false, each line stays a single cell (lists still split per line).
   */
  splitSentences?: boolean
  /** Which template's rules to read the package with. Defaults to a study Bible. */
  edition?: BiblicaEdition
}

/**
 * Import the notes from a Biblica IDML package.
 *
 * The package parses through the same shared v2 engine as a plain IDML import,
 * so cells keep their protected anchors, exact locators, and preserved source
 * bytes — strict IDML export still works. Only the note paragraphs become cells;
 * which paragraphs those are depends on the edition (see `./editions.ts`).
 *
 * The study Bible's own front and back matter — contents, "how to use", the
 * Bible Dictionary, the timelines, the maps, the cover — ships as separate
 * volumes holding no scripture at all, which is how the reader recognizes them
 * without another toggle. There every text-bearing paragraph is a cell.
 */
export async function importBiblicaStudyNotes(
  file: File,
  ctx: ImportContext,
  onProgress?: (p: BiblicaProgress) => void,
  options?: BiblicaImportOptions,
): Promise<FileReference> {
  // Every Biblica title ships as InDesign, so a non-IDML file is the user
  // picking the wrong importer rather than a package this reader cannot handle.
  if (!/\.idml$/i.test(file.name)) {
    throw new Error(t("importExport.errors.biblicaExpectsIdml"))
  }
  return importPartnerNotes(file, ctx, onProgress, {
    edition: BIBLICA_EDITIONS[options?.edition ?? "study-notes"],
    ...(options?.splitSentences !== undefined
      ? { splitSentences: options.splitSentences }
      : {}),
  })
}
