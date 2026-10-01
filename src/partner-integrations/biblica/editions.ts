/**
 * Biblica's four InDesign templates (AQU-1286; extracted from `src/lib/import.ts`).
 *
 * Nothing inside an IDML package says which title it is, and the four templates
 * disagree about what a paragraph style means — a study Bible marks its notes
 * positively (`intro:*`), the Treasure Hunt Bible and Reach4Life mark scripture
 * instead, and an EBL guide has no scripture to mark — so the person importing
 * says which one this is.
 *
 * Each `parse` thunk imports its reader on demand, which is what keeps the IDML
 * reading layer out of the app's initial bundle, and flattens that reader's
 * result into the shared `PartnerParseOutcome` so generic code never has to know
 * which one ran.
 */

import type { PartnerImportEdition, PartnerParseOptions } from "@/lib/partners/types"

/** Which Biblica title an IDML package is. */
export type BiblicaEdition = "study-notes" | "treasure-hunt" | "reach4life" | "ebl"

/** Distinguishes a notes-only Biblica import from a whole-package IDML import. */
export const BIBLICA_NOTES_PROFILE_ID = "builtin:biblica-study-notes"

/**
 * The Treasure Hunt Bible is a different InDesign template with the opposite
 * marking convention, so it gets its own profile — the cells are not
 * interchangeable with study-Bible notes even though both are Biblica IDML.
 */
export const TREASURE_HUNT_PROFILE_ID = "builtin:biblica-treasure-hunt"

/**
 * Reach4Life is a third template again — a teenagers' workbook wrapped around
 * the NIrV, organized by lesson rather than by chapter.
 */
export const REACH4LIFE_PROFILE_ID = "builtin:biblica-reach4life"

/**
 * Equipping Biblical Leaders is a fourth template — a training programme's
 * facilitator and participant guides, divided by topic and lesson rather than
 * by book, and holding no published scripture to set anything around.
 */
export const EBL_PROFILE_ID = "builtin:biblica-ebl"

const STUDY_NOTES: PartnerImportEdition = {
  id: "biblica:study-notes",
  profileId: BIBLICA_NOTES_PROFILE_ID,
  // Sidebar folder per edition, so a project holding more than one Biblica title
  // keeps them apart. The user can rename it or move a file out of it later.
  corpusMarker: "Biblica Study Notes",
  async parse(buffer: ArrayBuffer, options: PartnerParseOptions) {
    const { extractBiblicaStudyNoteStrings } = await import("./parsers/biblica")
    const { strings, bookCodes, skipped, frontBackMatter } =
      await extractBiblicaStudyNoteStrings(buffer, undefined, options)
    return {
      strings,
      bookCodes,
      skippedScriptureCount: skipped.verseUnitCount,
      frontBackMatter,
    }
  },
  emptyImportMessage(fileName: string) {
    return `${fileName} parsed successfully but contained no study notes. `
      + "Biblica notes live in `intro:*` paragraph styles — check that this is the notes "
      + "document. If this is a Treasure Hunt Bible, a Reach 4 Life or an EBL file, tick the "
      + "matching box and import it again."
  },
}

const TREASURE_HUNT: PartnerImportEdition = {
  id: "biblica:treasure-hunt",
  profileId: TREASURE_HUNT_PROFILE_ID,
  corpusMarker: "Treasure Hunt Bible",
  async parse(buffer: ArrayBuffer, options: PartnerParseOptions) {
    const { extractTreasureHuntStrings } = await import("./parsers/biblica-treasure-hunt")
    const { strings, bookCodes, skipped } =
      await extractTreasureHuntStrings(buffer, undefined, options)
    return {
      strings,
      bookCodes,
      skippedScriptureCount: skipped.scriptureUnitCount,
      frontBackMatter: false,
    }
  },
  emptyImportMessage(fileName: string) {
    return `${fileName} parsed successfully but contained no Treasure Hunt notes. `
      + "Treasure Hunt content lives in `!meta_*`, `_intro_*` and front-matter paragraph "
      + "styles — check that this is a Treasure Hunt volume."
  },
}

const REACH4LIFE: PartnerImportEdition = {
  id: "biblica:reach4life",
  profileId: REACH4LIFE_PROFILE_ID,
  corpusMarker: "Reach 4 Life",
  async parse(buffer: ArrayBuffer, options: PartnerParseOptions) {
    const { extractReach4LifeStrings } = await import("./parsers/biblica-reach4life")
    const { strings, bookCodes, skipped } =
      await extractReach4LifeStrings(buffer, undefined, options)
    return {
      strings,
      bookCodes,
      skippedScriptureCount: skipped.scriptureUnitCount,
      frontBackMatter: false,
    }
  },
  emptyImportMessage(fileName: string) {
    return `${fileName} parsed successfully but contained no Reach 4 Life content. `
      + "Reach 4 Life content lives in the `R4Lv4 Paragraph Styles:*` lesson groups and in "
      + "the `Metatext_BBI Bible Book Intros:*`, `Intros:*` and `Copyright:*` styles — check "
      + "that this is a Reach 4 Life package."
  },
}

const EBL: PartnerImportEdition = {
  id: "biblica:ebl",
  profileId: EBL_PROFILE_ID,
  corpusMarker: "Equipping Biblical Leaders",
  async parse(buffer: ArrayBuffer, options: PartnerParseOptions) {
    const { extractEblStrings } = await import("./parsers/biblica-ebl")
    // A guide is written material throughout, so nothing is skipped for being
    // scripture and no one book owns the file.
    const { strings } = await extractEblStrings(buffer, undefined, options)
    return { strings, bookCodes: [], skippedScriptureCount: 0, frontBackMatter: false }
  },
  emptyImportMessage(fileName: string) {
    // Nothing is filtered out by edition here, so an empty result means the
    // package carried no text at all rather than the wrong template.
    return `${fileName} parsed successfully but contained no text. An EBL guide imports `
      + "every text-bearing paragraph, so this package holds only artwork — check that "
      + "this is the guide rather than a cover or plate volume."
  },
}

export const BIBLICA_EDITIONS: Readonly<Record<BiblicaEdition, PartnerImportEdition>> = {
  "study-notes": STUDY_NOTES,
  "treasure-hunt": TREASURE_HUNT,
  reach4life: REACH4LIFE,
  ebl: EBL,
}
