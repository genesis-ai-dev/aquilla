// Paratext's canon list: 123 codes, contiguous. Index i (0-based) is the
// <BooksPresent> bit position. The FILE-NAME number skips 40 (MAT is 41, REV
// 67, TOB 68 … XXG 100) and from 101 on uses a letter + digit (FRT A0, INT A7,
// TDX B0, LAO C3) — see `bookNumberToken`. Verified against a real Paratext 9.5
// project's file names and its BooksPresent string.
export const BOOK_CODES_BY_NUMBER: readonly string[] = [
  "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA",
  "1KI", "2KI", "1CH", "2CH", "EZR", "NEH", "EST", "JOB", "PSA", "PRO",
  "ECC", "SNG", "ISA", "JER", "LAM", "EZK", "DAN", "HOS", "JOL", "AMO",
  "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
  "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH",
  "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS",
  "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV", "TOB", "JDT", "ESG",
  "WIS", "SIR", "BAR", "LJE", "S3Y", "SUS", "BEL", "1MA", "2MA", "3MA",
  "4MA", "1ES", "2ES", "MAN", "PS2", "ODA", "PSS", "JSA", "JDB", "TBS",
  "SST", "DNT", "BLT", "XXA", "XXB", "XXC", "XXD", "XXE", "XXF", "XXG",
  "FRT", "BAK", "OTH", "3ES", "EZA", "5EZ", "6EZ", "INT", "CNC", "GLO",
  "TDX", "NDX", "DAG", "PS3", "2BA", "LBA", "JUB", "ENO", "1MQ", "2MQ",
  "3MQ", "REP", "4BA", "LAO",
]
