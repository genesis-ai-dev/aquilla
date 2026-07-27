// Worker-safe parse core for DOM-free import formats.
//
// Every parser reachable from here is pure string/regex work — NO DOMParser,
// no `window`, no `document` — so this module can run inside a Web Worker. The
// XML-based formats (docx, pptx, xliff, tmx, usx) stay on the main thread
// because their parsers depend on the Window-only `DOMParser`; routing them
// here would throw "DOMParser is not defined". See parseFile() in ../import.ts
// for the main-thread split.
//
// `usfmSectionToStrings` lives here (moved from import.ts) so the worker bundle
// never pulls in import.ts and its DOM-bound parser imports.

import { v7 as uuidv7 } from "uuid"
import { extractPlaintextStrings } from "./plaintext"
import { extractMarkdownStrings } from "./markdown"
import { parseObsStories } from "./obs"
import { extractVttStrings, extractSrtStrings } from "./subtitle"
import { parseCsvBilingual } from "./csv-bilingual"
import { parseUsfmLossless } from "./usfm-lossless"
import { extractJsonStrings } from "./json-i18n"
import { extractPoStrings } from "./po"
import { extractPropertiesStrings } from "./properties"
import { extractSbvStrings } from "./sbv"
import type { TranslatableString } from "./types"
// Type-only import — erased by the bundler, so this does NOT pull import.ts (or
// its DOMParser-using parsers) into the worker bundle.
import type { ImportResult } from "../import"

/** DOM-free file types handled by this module (and therefore the parse worker). */
export type TextParseFileType = "txt" | "md" | "json" | "po" | "properties" | "obs" | "vtt" | "srt" | "sbv" | "csv" | "tsv" | "usfm"

/** Set form for routing decisions in parseFile(). DOM-bound formats (docx,
 *  pptx, xliff, tmx) are intentionally absent — they need the main thread. */
export const TEXT_PARSE_FILE_TYPES: ReadonlySet<string> = new Set<TextParseFileType>([
  "txt",
  "md",
  "json",
  "po",
  "properties",
  "obs",
  "vtt",
  "srt",
  "sbv",
  "csv",
  "tsv",
  "usfm",
])

export interface TextParseRequest {
  fileType: TextParseFileType
  /** File text. For `usfm` this is already-USFM — any USX→USFM conversion (which
   *  needs DOMParser) happens on the main thread before the request is sent. */
  text: string
  /** Display name (file name) — used for result naming and OBS story refs. */
  name: string
  /** USFM only: when true, exclude book-name/title/TOC + intro-block front
   *  matter from the emitted cells (per-project opt-out, AQU-634). Default:
   *  false (import front matter). */
  excludeFrontMatter?: boolean
}

/** Parse one USFM book section into translatable cells (verse bodies + heading/
 *  title/intro paratext), in document order. Shared by plain-USFM import and the
 *  per-book split below. Moved verbatim from import.ts. */
export function usfmSectionToStrings(
  section: string,
  opts?: { excludeFrontMatter?: boolean },
): {
  bookId: string
  strings: TranslatableString[]
  duplicateRefs: string[]
} {
  const doc = parseUsfmLossless(section, { excludeFrontMatter: opts?.excludeFrontMatter })
  const bookId = doc.bookId || "unknown"
  const seen = new Set<string>()
  const duplicateRefs: string[] = []
  for (const v of doc.verses) {
    if (seen.has(v.ref)) duplicateRefs.push(v.ref)
    else seen.add(v.ref)
  }
  const allSpans = [
    ...doc.verses.map((v) => ({
      order: v.textStart,
      ref: v.ref,
      text: v.text.trim(),
      section: `${bookId} ${v.chapter}`,
      type: "verse" as const,
      paragraphStart: v.paragraphStart,
    })),
    ...doc.headings.map((h) => ({
      order: h.textStart,
      ref: h.ref,
      text: h.text.trim(),
      section: h.chapter > 0 ? `${bookId} ${h.chapter}` : bookId,
      type: h.kind,
      paragraphStart: undefined as boolean | undefined,
    })),
  ].sort((a, b) => a.order - b.order)
  const strings: TranslatableString[] = allSpans.map((s) => ({
    id: uuidv7(),
    original: s.text,
    translated: "",
    context: s.ref,
    group: s.ref,
    section: s.section,
    globalReferences: [s.ref],
    type: s.type,
    ...(s.paragraphStart ? { paragraphStart: true } : {}),
  }))
  return { bookId, strings, duplicateRefs }
}

/**
 * Parse a DOM-free import format into ImportResult[]. Pure and worker-safe.
 * Mirrors the corresponding branches of parseFile() exactly — the only
 * difference is that the raw text is supplied directly instead of read from a
 * File (so this can run off the main thread).
 */
export function parseTextFormat(req: TextParseRequest): ImportResult[] {
  const { fileType, text, name, excludeFrontMatter } = req
  switch (fileType) {
    case "txt":
      return [{ name, strings: extractPlaintextStrings(text) }]
    case "md":
      return [{ name, strings: extractMarkdownStrings(text) }]
    case "json":
      return [{ name, strings: extractJsonStrings(text) }]
    case "po":
      return [{ name, strings: extractPoStrings(text) }]
    case "properties":
      return [{ name, strings: extractPropertiesStrings(text) }]
    case "obs":
      return [{ name, strings: parseObsStories(text, name) }]
    case "vtt":
      return [{ name, strings: extractVttStrings(text) }]
    case "srt":
      return [{ name, strings: extractSrtStrings(text) }]
    case "sbv":
      return [{ name, strings: extractSbvStrings(text) }]
    case "csv":
    case "tsv":
      return [{ name, strings: parseCsvBilingual(text) }]
    case "usfm": {
      // Multi-book files (concatenated with \id boundaries) split here so each
      // book becomes its own result — matches Paratext convention.
      const sections = text.includes("\\id ")
        ? text.split(/(?=\\id\s)/).filter((s) => s.trim().length > 0)
        : [text]
      return sections.map((section) => {
        const { bookId, strings, duplicateRefs } = usfmSectionToStrings(section, {
          excludeFrontMatter,
        })
        if (duplicateRefs.length > 0) {
          console.warn(
            `[usfm import] ${name}: ${duplicateRefs.length} duplicate verse ref(s) — ` +
              `${duplicateRefs.slice(0, 5).join(", ")}${duplicateRefs.length > 5 ? `, +${duplicateRefs.length - 5} more` : ""}`,
          )
        }
        return {
          name: name === bookId ? bookId : sections.length > 1 ? bookId : name,
          strings,
          rawSource: section,
          rawSourceFormat: "usfm",
        }
      })
    }
  }
}
