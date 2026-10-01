// Translation-note reference metadata (AQU-527) — the untranslated columns a
// unfoldingWord-style TN row carries alongside its prose.
//
// A TN row is `Reference | ID | Tags | SupportReference | Quote | Occurrence |
// Note`. Only `Note` is translatable, so both ingestion paths (the DCS resource
// route `src/lib/dcs/routes/tsv-notes.ts`, and the direct TSV import
// `src/lib/parsers/translation-notes.ts`) keep the note prose as the cell value
// and carry the rest in `cells.metadata`. That is the right split for editing —
// but it is why the editor's notes sidebar showed the prose alone, and why UW
// reported the notes had "taken the actual original language phrase out… we
// needed the original language phrase" (2026-07-09 demo). A note that says
// «here, the word **Now** introduces the next event» is unusable without the
// δὲ it is about.
//
// This module is the reading half: pure accessors over that metadata bucket, so
// the sidebar renders the same fields whichever importer produced the cell.

/** The quote's script, as a BCP-47 tag suitable for a `lang` attribute. */
export type QuoteScript = "he" | "grc"

export interface NoteReferenceMetadata {
  /** The original-language phrase the note is about. Null when the row had none. */
  quote: string | null
  /** Script of `quote`, for font selection and screen readers. Null when the
   *  phrase is in neither Hebrew nor Greek script (a gloss-only row, or a note
   *  on a non-scripture resource). */
  quoteScript: QuoteScript | null
  /** Which occurrence of `quote` in the verse the note addresses, when that
   *  disambiguates anything — so null for an absent, unparseable or `1` value,
   *  and for unfoldingWord's `-1` ("every occurrence"), which names no
   *  particular one. */
  occurrence: number | null
  /** The row's `SupportReference` — a `rc://` link into the translation
   *  academy, or a bare tag. Null when absent. */
  supportReference: string | null
}

/** Metadata keys the two importers write. `origQuote` is read defensively:
 *  the DCS route canonicalizes `OrigQuote` → `quote`, but a cell projected by
 *  an older importer can still carry the raw header name. */
const QUOTE_KEYS = ["quote", "origQuote", "origquote"] as const
const SUPPORT_KEYS = ["supportReference", "supportref", "tags"] as const

function readString(
  metadata: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return null
}

/**
 * Which script a phrase is written in, by counting characters in each block —
 * a Hebrew quote carries cantillation marks and a Greek one carries accents, so
 * a first-character test is not enough, and either can contain stray Latin
 * punctuation from the source file.
 */
export function detectQuoteScript(quote: string): QuoteScript | null {
  let hebrew = 0
  let greek = 0
  for (const char of quote) {
    const cp = char.codePointAt(0)!
    // Hebrew, plus the alphabetic presentation forms (ligatures, pointed forms).
    if ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f)) hebrew++
    // Greek and Coptic, plus Greek Extended (the polytonic accents the NT uses).
    else if ((cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x1f00 && cp <= 0x1fff)) greek++
  }
  if (hebrew === 0 && greek === 0) return null
  return hebrew >= greek ? "he" : "grc"
}

/**
 * Occurrence as a number the reader can act on. unfoldingWord writes `1` for
 * the ordinary case and `-1` for "every occurrence"; neither singles out a
 * position, so both read as null and the UI shows no marker.
 */
function readOccurrence(metadata: Record<string, unknown>): number | null {
  const raw = metadata["occurrence"]
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 1) return null
  return value
}

/** Read a note cell's reference metadata. A missing bucket reads as all-null,
 *  so the sidebar renders prose-only notes without a special case. */
export function readNoteReferenceMetadata(
  metadata: Record<string, unknown> | null | undefined,
): NoteReferenceMetadata {
  if (!metadata || typeof metadata !== "object") {
    return { quote: null, quoteScript: null, occurrence: null, supportReference: null }
  }
  const quote = readString(metadata, QUOTE_KEYS)
  return {
    quote,
    quoteScript: quote ? detectQuoteScript(quote) : null,
    occurrence: readOccurrence(metadata),
    supportReference: readString(metadata, SUPPORT_KEYS),
  }
}

/**
 * Readable label for a support reference. A value like
 * `rc://…/ta/man/translate/figs-merism` is a resource-container URI, not prose
 * — the last segment is the article name, which is the part a translator
 * recognizes. A bare tag is returned unchanged.
 */
export function supportReferenceLabel(supportReference: string): string {
  const tail = supportReference.replace(/\/+$/, "").split("/").pop() ?? supportReference
  return tail.replace(/[-_]+/g, " ").trim() || supportReference
}
