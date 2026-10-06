// Smart quotes for the translation editor: typing " or ' turns into curly
// quotes as you type, the way Word's AutoFormat does. Off unless the project
// turns on `smartQuotes`.
//
// Only the DOUBLE quotes follow the target language. Single quotes are always
// ‘ ’ because the same key types apostrophes, and an apostrophe is ’ in every
// language that uses this key for one: a German closing ‘ or a French › would
// turn "geht's" into "geht‘s". Typing a straight quote right after a
// conversion and pressing Backspace restores it (TipTap's undoInputRule).

import Typography from "@tiptap/extension-typography"
import { normalizeLanguageTag } from "@/lib/language-normalize"

export interface DoubleQuoteMarks {
  open: string
  close: string
}

const ENGLISH: DoubleQuoteMarks = { open: "“", close: "”" }

/** Primary double quotation marks (CLDR delimiters), keyed by ISO 639-3. */
const DOUBLE_QUOTES: Record<string, DoubleQuoteMarks> = {
  fra: { open: "«", close: "»" },
  spa: { open: "«", close: "»" },
  ita: { open: "«", close: "»" },
  rus: { open: "«", close: "»" },
  ukr: { open: "«", close: "»" },
  nor: { open: "«", close: "»" },
  ell: { open: "«", close: "»" },
  deu: { open: "„", close: "“" },
  ces: { open: "„", close: "“" },
  bul: { open: "„", close: "“" },
  hrv: { open: "„", close: "“" },
  lit: { open: "„", close: "“" },
  pol: { open: "„", close: "”" },
  hun: { open: "„", close: "”" },
  ron: { open: "„", close: "”" },
  swe: { open: "”", close: "”" },
  fin: { open: "”", close: "”" },
  jpn: { open: "「", close: "」" },
}

/** The double quotes for a target language; English “ ” when unknown or unset. */
export function doubleQuoteMarks(lang: string | undefined | null): DoubleQuoteMarks {
  return knownDoubleQuoteMarks(lang) ?? ENGLISH
}

/** AQU-1688: the table's own entry for a language, or null where `doubleQuoteMarks` falls back to English. */
export function knownDoubleQuoteMarks(lang: string | undefined | null): DoubleQuoteMarks | null {
  return DOUBLE_QUOTES[normalizeLanguageTag(lang)] ?? null
}

/** The Typography extension with every rule off except the four quote rules. */
export function createSmartQuotesExtension(lang: string | undefined | null) {
  const { open, close } = doubleQuoteMarks(lang)
  return Typography.configure({
    openDoubleQuote: open,
    closeDoubleQuote: close,
    openSingleQuote: "‘",
    closeSingleQuote: "’",
    emDash: false,
    ellipsis: false,
    leftArrow: false,
    rightArrow: false,
    copyright: false,
    trademark: false,
    servicemark: false,
    registeredTrademark: false,
    oneHalf: false,
    plusMinus: false,
    notEqual: false,
    laquo: false,
    raquo: false,
    multiplication: false,
    superscriptTwo: false,
    superscriptThree: false,
    oneQuarter: false,
    threeQuarters: false,
  })
}
