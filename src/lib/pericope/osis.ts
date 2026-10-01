/**
 * OSIS book abbreviation → USFM book code (AQU-515).
 *
 * The OpenBible section-counts dataset addresses verses OSIS style (`Gen.2.4`,
 * `1Sam.3.1`, `Phlm.1.4`); everything inside Aquilla addresses them by the USFM
 * code a `canonicalRef` carries (`GEN 2:4`). This table is the only place the
 * two vocabularies meet, so a dataset refresh that renames a book fails in one
 * spot rather than silently dropping that book's suggestions.
 *
 * Protestant 66 only — the dataset carries no deuterocanon, and a file whose
 * book is missing here simply gets no suggestions (see `suggest.ts`).
 */
const USFM_BY_OSIS: Readonly<Record<string, string>> = {
  Gen: "GEN", Exod: "EXO", Lev: "LEV", Num: "NUM", Deut: "DEU",
  Josh: "JOS", Judg: "JDG", Ruth: "RUT",
  "1Sam": "1SA", "2Sam": "2SA", "1Kgs": "1KI", "2Kgs": "2KI",
  "1Chr": "1CH", "2Chr": "2CH",
  Ezra: "EZR", Neh: "NEH", Esth: "EST", Job: "JOB", Ps: "PSA",
  Prov: "PRO", Eccl: "ECC", Song: "SNG",
  Isa: "ISA", Jer: "JER", Lam: "LAM", Ezek: "EZK", Dan: "DAN",
  Hos: "HOS", Joel: "JOL", Amos: "AMO", Obad: "OBA", Jonah: "JON",
  Mic: "MIC", Nah: "NAM", Hab: "HAB", Zeph: "ZEP", Hag: "HAG",
  Zech: "ZEC", Mal: "MAL",
  Matt: "MAT", Mark: "MRK", Luke: "LUK", John: "JHN", Acts: "ACT",
  Rom: "ROM", "1Cor": "1CO", "2Cor": "2CO", Gal: "GAL", Eph: "EPH",
  Phil: "PHP", Col: "COL", "1Thess": "1TH", "2Thess": "2TH",
  "1Tim": "1TI", "2Tim": "2TI", Titus: "TIT", Phlm: "PHM",
  Heb: "HEB", Jas: "JAS", "1Pet": "1PE", "2Pet": "2PE",
  "1John": "1JN", "2John": "2JN", "3John": "3JN", Jude: "JUD", Rev: "REV",
}

/** The USFM code for an OSIS abbreviation, or `undefined` when unmapped. */
export function usfmFromOsis(osis: string): string | undefined {
  return USFM_BY_OSIS[osis]
}

/** Exported so a test can assert the table still covers the whole dataset. */
export const OSIS_BOOK_COUNT = Object.keys(USFM_BY_OSIS).length
