import type { InfractionSpan } from "@/lib/parsers/types"
import { BookNameIndex } from "@/lib/audio/bulk-upload/book-names"
import { canonChapterCount } from "@/lib/bible-data/canon-chapters"
import type { BuiltinCheckRunContext, ProjectBookName } from "../builtin-run-context"

export const MESSAGE = "Scripture reference does not match the project's book names or the canon"

// AQU-1735: the References half of Paratext parity. It reads the scripture
// references a TRANSLATION writes — cross-references, footnotes,
// introductions — and flags three things:
//
//   1. a book name or abbreviation the project does not use ("Jn 3:17" in a
//      project whose book-name table says "Jhn");
//   2. a chapter the canon does not have (Psalm 151 in a Protestant-canon
//      project);
//   3. a chapter–verse separator that disagrees with the rest of the cell
//      ("Jhn 3:16 and Rom 1.17").
//
// The project's own names come from `context.bookNames` — its `\toc`/`\h`
// lines, a Paratext BookNames.xml, or the names of its imported files (see
// `projectBookNames`). They are consulted through `BookNameIndex`
// (src/lib/audio/bulk-upload/book-names.ts) rather than a second spelling
// table: that module already knows the USFM codes, the English names, the
// short forms people type and the Chinese Union Version names, and knows
// which of them are too short to trust away from a chapter number.
//
// WHY A TOKEN THAT NAMES NO BOOK AT ALL IS IGNORED: "Section 3:17" and "at
// 3:16 pm" are reference-SHAPED but name nothing, and this check also runs on
// software-localization projects. So the built-in spellings decide whether a
// match is a scripture reference at all; the project's table then decides
// whether it is spelled the project's way. That ordering is what keeps rule 1
// from firing on every ordinary sentence containing a colon.
//
// The check is OFF by default: rule 1 is only meaningful once a project has
// book names to compare against, exactly as Paratext's References row needs
// its scripture-reference settings first.
//
// Pure, and linear in the cell's length, so incremental-infractions re-runs
// only the edited cell.

/** Separators a reference may put between chapter and verse. */
const SEPARATORS = new Set([":", ".", ","])

/**
 * A reference-shaped run: up to two words before the chapter number (so "Song
 * of Songs 2:1" and "1 Samuel 3:2" both reach the scan), then a chapter, a
 * separator, a verse, and an optional range end. Anchored so it cannot start
 * mid-word or mid-number.
 *
 * The leading words are a candidate book name, not necessarily one: in "See Jn
 * 3:17" the run starts at "See". `scanReferences` therefore tries the run's
 * words from the longest tail down, which is also what reads "of Songs" as
 * Song of Songs' tail rather than giving up on the whole run.
 */
const REF_RE =
  /(?<![\p{L}\d])((?:[1-3]|[iI]{1,3}|[Ff]irst|[Ss]econd|[Tt]hird|1st|2nd|3rd)?[ \u00A0]*\p{L}[\p{L}.'’]*(?:[ \u00A0]+\p{L}[\p{L}.'’]*)?)[ \u00A0]*(\d{1,3})[ \u00A0]*([:.,])[ \u00A0]*(\d{1,3}[a-z]?)(?:[ \u00A0]*[-–][ \u00A0]*\d{1,3}[a-z]?)?/gu

/** Why a reference was flagged. Carried for tests and for a future message builder. */
export type ReferenceProblem = "book-name" | "chapter-out-of-range" | "separator"

/** One scripture reference the check read out of a cell. */
export interface ScannedReference {
  /** The whole reference as written, e.g. "Jn 3:17". */
  raw: string
  /** The book token as written, e.g. "Jn". */
  bookText: string
  /** The USFM code the built-in spellings give that token. */
  bookCode: string
  chapter: number
  separator: string
  start: number
  end: number
}

interface ProjectLookup {
  index: BookNameIndex
  known: Set<string>
}

/**
 * Keyed on the table's identity, which `resolveBuiltinRules` resolves once per
 * project and stamps on the rule — so a whole Bible's worth of cells builds
 * the lookup once, not once per cell per rule (the budget rule-engine.ts
 * states: ~31k cells x ~20 rules).
 */
const LOOKUP_CACHE = new WeakMap<readonly ProjectBookName[], ProjectLookup>()

/** The project's book-name table as a lookup. Null when the project has none. */
function projectIndex(bookNames: readonly ProjectBookName[] | null | undefined): ProjectLookup | null {
  if (!bookNames || bookNames.length === 0) return null
  const cached = LOOKUP_CACHE.get(bookNames)
  if (cached) return cached
  // `builtins: false`: only what the project itself calls its books counts,
  // which is the whole point of rule 1.
  const index = new BookNameIndex({ builtins: false })
  const known = new Set<string>()
  for (const entry of bookNames) {
    const code = entry.code.toUpperCase()
    known.add(code)
    // The USFM code and whatever the project wrote are both names for it; the
    // code because every project spells its own books' codes that way, and a
    // project table assembled from file names would otherwise reject "JHN".
    for (const name of [code, ...entry.names]) index.addProjectName(name, code)
  }
  const lookup: ProjectLookup = { index, known }
  LOOKUP_CACHE.set(bookNames, lookup)
  return lookup
}

/**
 * Every scripture reference in `text`, as the check reads them: a token the
 * built-in spellings recognise as a book, followed by chapter, separator and
 * verse. Exported so the tests can assert on the scan itself.
 */
export function scanReferences(text: string): ScannedReference[] {
  const builtins = new BookNameIndex()
  const out: ScannedReference[] = []
  for (const m of text.matchAll(REF_RE)) {
    if (m.index === undefined) continue
    const words = [...m[1].matchAll(/[^\s\u00A0]+/g)]
    for (let i = 0; i < words.length; i++) {
      const offset = words[i].index
      const bookText = words
        .slice(i)
        .map((w) => w[0])
        .join(" ")
      // A lowercase first letter is a word, not a book name ("at 3:16 pm",
      // "I am 3:16"). Scripts without case ("约 3:16") are unaffected.
      if (/^\p{Ll}/u.test(bookText)) continue
      // `weakOk`: the token sits right before the chapter number, which is the
      // one place `book-names.ts` trusts a one- or two-letter form.
      const hit = builtins.lookup(bookText, true)
      if (!hit) continue
      out.push({
        raw: m[0].slice(offset),
        bookText,
        bookCode: hit.code,
        chapter: Number(m[2]),
        separator: m[3],
        start: m.index + offset,
        end: m.index + m[0].length,
      })
      break
    }
  }
  return out
}

/** The problems one reference has, given the project's table and the cell's
 *  prevailing separator. Empty when the reference is fine. */
export function referenceProblems(
  ref: ScannedReference,
  project: ProjectLookup | null,
  prevailingSeparator: string,
): ReferenceProblem[] {
  const problems: ReferenceProblem[] = []

  // Rule 1. Only where the project has said something about THIS book: a
  // project that never imported Romans has no opinion on how to spell it.
  if (project?.known.has(ref.bookCode)) {
    // `weakOk: true` — the index holds only project names here, and the
    // token already sits against its chapter number.
    const own = project.index.lookup(ref.bookText, true)
    if (own?.code !== ref.bookCode) problems.push("book-name")
  }

  // Rule 2. The canon's chapter count. A code the canon does not have (a
  // deuterocanonical book) is left alone — this table is not its authority.
  const chapters = canonChapterCount(ref.bookCode)
  if (chapters !== null && (ref.chapter < 1 || ref.chapter > chapters)) {
    problems.push("chapter-out-of-range")
  }

  // Rule 3. One cell, one way of writing a reference.
  if (SEPARATORS.has(ref.separator) && ref.separator !== prevailingSeparator) {
    problems.push("separator")
  }

  return problems
}

export function runCheck(
  _source: string,
  target: string,
  context?: BuiltinCheckRunContext,
): InfractionSpan[] | null {
  const refs = scanReferences(target)
  if (refs.length === 0) return null

  const project = projectIndex(context?.bookNames)
  // The first reference in the cell sets the separator the rest must follow.
  const prevailingSeparator = refs[0].separator

  const spans: InfractionSpan[] = []
  for (const ref of refs) {
    if (referenceProblems(ref, project, prevailingSeparator).length === 0) continue
    spans.push({ side: "target", start: ref.start, end: ref.end, matchedText: ref.raw })
  }

  return spans.length > 0 ? spans : null
}
