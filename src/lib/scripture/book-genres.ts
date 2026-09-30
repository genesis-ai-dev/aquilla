/**
 * book-genres.ts — static USFM-book-code → literary-genre classification for
 * the 66-book Protestant canon. Feeds the style-rule applicability resolver
 * (src/lib/rules/applicability.ts): a `genre` applicability target like
 * "poetry" matches every cell whose book maps to that genre.
 *
 * Taxonomy (one genre per book — chapter-level nuance is handled by narrower
 * applicability rows, not by this map):
 *   - law         Pentateuch (GEN–DEU)
 *   - history     OT narrative (JOS–EST) plus Acts
 *   - wisdom      JOB, PRO, ECC
 *   - poetry      PSA, SNG, LAM (Lamentations classed by form, not canon slot)
 *   - prophecy    ISA, JER, EZK and the twelve minor prophets
 *   - gospel      MAT, MRK, LUK, JHN
 *   - epistle     ROM–JUD (Pauline + general letters, incl. HEB)
 *   - apocalyptic DAN, REV (Daniel's visions dominate its translation style;
 *                 narrative-chapter exceptions belong on section/passage rows)
 *
 * Codes are the standard 3-character USFM identifiers, matching
 * src/lib/file-labeling/bible-book-names.ts (the canonical code list).
 */

export type BookGenre =
  | "law"
  | "history"
  | "wisdom"
  | "poetry"
  | "prophecy"
  | "gospel"
  | "epistle"
  | "apocalyptic"

/** Every genre value the map can produce, for pickers and validation. */
export const BOOK_GENRES: readonly BookGenre[] = [
  "law",
  "history",
  "wisdom",
  "poetry",
  "prophecy",
  "gospel",
  "epistle",
  "apocalyptic",
]

const GENRE_BY_BOOK: Readonly<Record<string, BookGenre>> = {
  // Law
  GEN: "law", EXO: "law", LEV: "law", NUM: "law", DEU: "law",
  // History (OT narrative + Acts)
  JOS: "history", JDG: "history", RUT: "history",
  "1SA": "history", "2SA": "history", "1KI": "history", "2KI": "history",
  "1CH": "history", "2CH": "history",
  EZR: "history", NEH: "history", EST: "history",
  ACT: "history",
  // Wisdom
  JOB: "wisdom", PRO: "wisdom", ECC: "wisdom",
  // Poetry
  PSA: "poetry", SNG: "poetry", LAM: "poetry",
  // Prophecy (majors minus Daniel, plus the twelve)
  ISA: "prophecy", JER: "prophecy", EZK: "prophecy",
  HOS: "prophecy", JOL: "prophecy", AMO: "prophecy", OBA: "prophecy",
  JON: "prophecy", MIC: "prophecy", NAM: "prophecy", HAB: "prophecy",
  ZEP: "prophecy", HAG: "prophecy", ZEC: "prophecy", MAL: "prophecy",
  // Gospels
  MAT: "gospel", MRK: "gospel", LUK: "gospel", JHN: "gospel",
  // Epistles
  ROM: "epistle", "1CO": "epistle", "2CO": "epistle", GAL: "epistle",
  EPH: "epistle", PHP: "epistle", COL: "epistle",
  "1TH": "epistle", "2TH": "epistle",
  "1TI": "epistle", "2TI": "epistle", TIT: "epistle", PHM: "epistle",
  HEB: "epistle", JAS: "epistle",
  "1PE": "epistle", "2PE": "epistle",
  "1JN": "epistle", "2JN": "epistle", "3JN": "epistle", JUD: "epistle",
  // Apocalyptic
  DAN: "apocalyptic", REV: "apocalyptic",
}

/**
 * Genre for a USFM book code (case-insensitive). `undefined` for anything
 * outside the 66-book canon — non-scripture files simply have no genre
 * coordinate and fall back to file-level applicability rows.
 */
export function bookGenre(bookCode: string): BookGenre | undefined {
  return GENRE_BY_BOOK[(bookCode || "").trim().toUpperCase()]
}

/** The full map, exposed read-only for coverage tests and bulk tooling. */
export function allBookGenres(): Readonly<Record<string, BookGenre>> {
  return GENRE_BY_BOOK
}
