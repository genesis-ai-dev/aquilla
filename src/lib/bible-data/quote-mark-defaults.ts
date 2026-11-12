// Default quotation marks for the Language profile (AQU-1688): what "Use
// defaults for <language>" fills in.
//
// Level 1 always comes from the smart-quotes table (src/lib/richtext/
// smart-quotes.ts, CLDR primary delimiters), so the checks expect exactly the
// marks the editor types for the project. Levels 2 and 3 and the paragraph
// convention come from the table below, for the languages it lists. A
// language that only the smart-quotes table knows gets level 1 alone.
//
// Sources (levels 2–3 and paragraphs):
//   CLDR delimiters, `alternateQuotationStart/End` in common/main/<lang>.xml
//     (Unicode CLDR): the level-2 marks for en, es, pt, de, ru, id, zh.
//   en  The Chicago Manual of Style (17th ed.), ch. 13 "Quotations and
//       Dialogue": double, then single, then double; a quotation over several
//       paragraphs repeats the opening mark at each paragraph and closes once.
//   es  Real Academia Española, Ortografía de la lengua española (2010) and
//       Diccionario panhispánico de dudas, "comillas": « » outside, then “ ”,
//       then ‘ ’; later paragraphs of a quotation start with » (comillas de seguir).
//   fr  Lexique des règles typographiques en usage à l'Imprimerie nationale:
//       « » outside, “ ” inside. UNCERTAIN: level 3 (‘ ’) and the paragraph
//       convention vary by publisher (CLDR fr repeats « » at level 2).
//   pt  CLDR pt: “ ” then ‘ ’. UNCERTAIN: level 3; European Portuguese often
//       starts with « », which the smart-quotes table does not distinguish.
//   de  Duden: „ “ outside, ‚ ‘ inside. UNCERTAIN: the paragraph convention.
//   ru  CLDR ru and Russian publishing practice (А. Э. Мильчин, Справочник
//       издателя и автора): « » outside, „ “ inside. UNCERTAIN: level 3.
//   id  CLDR id and PUEBI (Pedoman Umum Ejaan Bahasa Indonesia): “ ” then ‘ ’.
//       UNCERTAIN: the paragraph convention.
//   ar  UNCERTAIN throughout. CLDR ar uses ” “ and ’ ‘ (U+201D opens), and many
//       Arabic Bibles use « ». The smart-quotes table has no Arabic entry, so
//       level 1 is the editor's “ ”, and level 2 follows it with ‘ ’.
//   zh  GB/T 15834-2011 (标点符号用法): “ ” outside, ‘ ’ inside, and a quotation
//       over several paragraphs reopens each paragraph. UNCERTAIN for texts in
//       traditional script, which often use 「 」 and 『 』 instead.
// Languages only the smart-quotes table knows default to
// "reopen-each-paragraph", which is UNCERTAIN for each of them.

import { doubleQuoteMarks, knownDoubleQuoteMarks } from "@/lib/richtext/smart-quotes"
import { normalizeLanguageTag } from "@/lib/language-normalize"
import type {
  QuoteContinuationStyle,
  QuoteMarkPair,
  QuoteMarksProfile,
} from "../../../db/shared/language-profile"

interface DeeperLevels {
  levels: QuoteMarkPair[]
  continuation: QuoteContinuationStyle
}

const pair = (open: string, close: string): QuoteMarkPair => ({ open, close })

/** Levels 2 and 3 and the paragraph convention, keyed by ISO 639-3 (see the sources above). */
const DEEPER: Readonly<Record<string, DeeperLevels>> = {
  eng: { levels: [pair("‘", "’"), pair("“", "”")], continuation: "reopen-each-paragraph" },
  spa: { levels: [pair("“", "”"), pair("‘", "’")], continuation: "continuation-mark" },
  fra: { levels: [pair("“", "”"), pair("‘", "’")], continuation: "reopen-each-paragraph" },
  por: { levels: [pair("‘", "’"), pair("“", "”")], continuation: "reopen-each-paragraph" },
  deu: { levels: [pair("‚", "‘")], continuation: "reopen-each-paragraph" },
  rus: { levels: [pair("„", "“")], continuation: "reopen-each-paragraph" },
  ind: { levels: [pair("‘", "’")], continuation: "reopen-each-paragraph" },
  ara: { levels: [pair("‘", "’")], continuation: "none" },
  zho: { levels: [pair("‘", "’")], continuation: "reopen-each-paragraph" },
}

/** ISO codes that `normalizeLanguageTag` leaves alone but that mean a language above. */
const ALIASES: Readonly<Record<string, string>> = { arb: "ara", cmn: "zho" }

/**
 * The usual quotation marks for a target language, or null when neither
 * table knows it (then the card offers no defaults, rather than guess).
 */
export function defaultQuoteMarks(language: string | null | undefined): QuoteMarksProfile | null {
  const code = normalizeLanguageTag(language)
  const deeper = DEEPER[ALIASES[code] ?? code]
  if (!deeper && !knownDoubleQuoteMarks(language)) return null
  const primary = doubleQuoteMarks(language)
  return {
    levels: [pair(primary.open, primary.close), ...(deeper?.levels ?? [])],
    continuation: deeper?.continuation ?? "reopen-each-paragraph",
  }
}
