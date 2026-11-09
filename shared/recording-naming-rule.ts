// AQU-2302: the naming rule the assistant may describe for a recordings folder,
// checked by ONE module on both sides. The browser (src/lib/audio/bulk-upload/
// naming-rule.ts) compiles and applies it; the auth worker
// (routes/import-recording-names.ts) checks the model's answer and every rule
// it saves with these same functions, so neither side can accept a rule the
// other would refuse (review, Oct 30).
//
// A rule is declarative: one or two templates of literal text and
// placeholders, plus book words and constants. Nothing the assistant writes
// ever runs as an expression; the app builds its own anchored match from the
// template. Every check here returns null for a bad rule instead of throwing.
//
// Book words are read with the bulk upload's own book-name table
// (src/lib/audio/bulk-upload/book-names.ts, which imports nothing), so both
// sides read "Mt" and "Mark" the same way.

import { BookNameIndex, bookKey, englishBookName } from "../src/lib/audio/bulk-upload/book-names"

/** The 66 USFM book codes a rule may name, in canonical order. Pinned to the
 *  bulk upload's own book table by naming-rule.test.ts. */
export const USFM_BOOK_CODES: readonly string[] = [
  "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH", "2CH", "EZR", "NEH", "EST",
  "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER", "LAM", "EZK", "DAN", "HOS", "JOL", "AMO", "OBA", "JON", "MIC", "NAM",
  "HAB", "ZEP", "HAG", "ZEC", "MAL",
  "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH", "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT",
  "PHM", "HEB", "JAS", "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
]
const BOOK_CODE_SET: ReadonlySet<string> = new Set(USFM_BOOK_CODES)

/** At most this many names go up in one request. */
export const MAX_RULE_NAMES = 40
/** The project outline is trimmed to this before it is sent. */
export const MAX_OUTLINE_CHARS = 8_000
/** The sentence the person reads is trimmed to this, never refused for it. */
export const MAX_EXPLANATION_CHARS = 300
const MAX_PATTERN = 120
const MAX_PLACEHOLDERS = 6
/** Text to ignore, at most twice a template: more makes a name slow to read. */
const MAX_ANY = 2
const MAX_BOOK_WORDS = 30
/** Why an answer was refused, as told to the assistant on the one re-ask, is
 *  never longer than this (AQU-2496). */
export const MAX_REFUSAL_CHARS = 400

/** One way the names are written, matched against the file name without its
 *  extension. Only the file name: the assistant is never shown the folders, so
 *  a template can't be about them (review, Oct 30). */
export interface NameTemplate {
  pattern: string
}

export interface NamingRule {
  version: 1
  /** One template, or two when the folder mixes two namings. */
  templates: NameTemplate[]
  /** What the `{book}` text means, when it isn't a book name the app knows:
   *  "mt" → "MAT". Keys are kept in lower case. A word the app's table reads
   *  as another book is refused; one that names no book at all is a constant
   *  in disguise (`bookWordNames`). */
  books?: Record<string, string>
  /** The book every file is for, when the names don't say it. */
  book?: string
  /** The chapter every file is for, when the names don't say it. */
  chapter?: number
  /** The project file every file is for, when it isn't a Bible book. */
  file?: string
  /** One plain sentence the person sees: what the assistant read. */
  explanation?: string
}

/** The placeholders a template may use, and what each one captures. */
const PLACEHOLDERS = {
  // AQU-2496 (review, Nov 9): a book word is its letters and the marks written
  // on them, as the bulk upload's own name reader takes a word, so a rule reads
  // a book named in Hindi, Bengali, Thai or vowelled Arabic ("उत्पत्ति").
  book: "([1-3]?\\s?[\\p{L}][\\p{L}\\p{M}\\u200c\\u200d.']{0,29}?)",
  chapter: "(\\d{1,3})",
  verse: "(\\d{1,3})",
  /** The last verse of a recording of several ("v01-03"): with {verse}, a range. */
  toVerse: "(\\d{1,3})",
  verseInBook: "(\\d{1,5})",
  line: "(\\d{1,5})",
  take: "(\\d{1,2})",
  part: "(\\d{1,2}|[a-h])",
  any: "(.*?)",
} as const
export type Placeholder = keyof typeof PLACEHOLDERS

const PLACEHOLDER_LIST = Object.keys(PLACEHOLDERS).map((name) => `{${name}}`).join(" ")

function isPlaceholder(name: string): name is Placeholder {
  // Own keys only: "{constructor}" must never reach Object.prototype.
  return Object.hasOwn(PLACEHOLDERS, name)
}

export interface CompiledTemplate {
  re: RegExp
  /** Placeholder names in capture order. */
  names: Placeholder[]
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Names and patterns are compared in one Unicode form: accents composed,
 *  full-width digits as ASCII digits. */
export function normalizeName(text: string): string {
  return text.normalize("NFKC")
}

type Kind = "literal" | "letters" | "digits" | "part" | "any"

/**
 * A template becomes a fixed, anchored expression built only from escaped
 * literal text and the placeholder classes above. Refused, because nothing
 * could tell where one value ends and the next begins:
 *   - two numbers side by side ("{chapter}{verse}");
 *   - a book word, or a part, run straight on to a part ("{book}{part}");
 *   - a number or a book word straight after a part ("{part}{verse}": "121"
 *     can't split);
 *   - text to ignore beside any placeholder, or more than two of it;
 *   - any other placeholder twice: only one of its values could be used
 *     ("v{verse}-{verse}" kept the last verse of "v01-03"). A range is
 *     "{verse}-{toVerse}" (review, Oct 30).
 * A part run straight on to a number can only be its letter ("4a"), and that
 * letter may be missing: "v{verse}{part}" fits "v01" as well as "v02a", so one
 * template reads a folder that mixes whole verses and pieces (AQU-2496,
 * review, Nov 9; before, "v01" needed a second template and was left unplaced).
 *
 * A refused template comes back as the reason, a clause the assistant is told
 * when it is asked once more (`whyRuleRefused`).
 */
function compilePart(raw: string): { re: RegExp; names: Placeholder[] } | string {
  const pattern = normalizeName(raw)
  if (pattern.length === 0 || pattern.length > MAX_PATTERN) return `a template must be 1 to ${MAX_PATTERN} characters long`
  const names: Placeholder[] = []
  let source = ""
  let last: Kind | null = null
  let rest = pattern
  while (rest.length > 0) {
    const m = /^\{([a-zA-Z_]+)\}/.exec(rest)
    if (m) {
      const name = m[1]
      if (!isPlaceholder(name)) return `{${name}} is not a placeholder; the only placeholders are ${PLACEHOLDER_LIST}`
      if (name !== "any" && names.includes(name)) return `{${name}} is used twice; only {any} may be used twice`
      const kind: Kind = name === "book" ? "letters" : name === "any" ? "any" : name === "part" ? "part" : "digits"
      if (last !== null && last !== "literal") {
        if (kind === "any" || last === "any") return "{any} can't sit right beside another placeholder; write the literal text that separates them, or use a second template"
        if (last === kind) return kind === "digits" ? "two number placeholders sit side by side with no text between them" : "two placeholders of one kind sit side by side with no text between them"
        if (kind === "part" && last === "letters") return "{part} can't come straight after {book}"
        if ((kind === "digits" || kind === "letters") && last === "part") return "only literal text may come straight after {part}"
      }
      names.push(name)
      source += kind === "part" && last === "digits" ? "([a-h])?" : PLACEHOLDERS[name]
      last = kind
      rest = rest.slice(m[0].length)
      continue
    }
    const next = rest.search(/\{[a-zA-Z_]+\}/)
    const literal = next < 0 ? rest : rest.slice(0, next)
    if (literal.includes("{") || literal.includes("}")) return "braces are only for placeholders, written exactly as listed; a placeholder can't be optional or hold anything but its name"
    source += escapeLiteral(literal)
    last = "literal"
    rest = rest.slice(literal.length)
  }
  if (names.length === 0) return "a template needs at least one placeholder"
  if (names.length > MAX_PLACEHOLDERS) return `a template may use at most ${MAX_PLACEHOLDERS} placeholders`
  if (names.filter((n) => n === "any").length > MAX_ANY) return `{any} may be used at most ${MAX_ANY} times in a template`
  try {
    return { re: new RegExp(`^${source}$`, "iu"), names }
  } catch {
    return "the template could not be read"
  }
}

/** A template compiled, or why it can't be. */
function compileOrWhy(template: NameTemplate): CompiledTemplate | string {
  // A template read off any other shape (a folder from an older answer) is
  // nothing this app can apply.
  if (Object.keys(template).some((key) => key !== "pattern")) return "a template holds only its \"pattern\""
  const name = compilePart(template.pattern)
  if (typeof name === "string") return name
  // A range's end needs its start, read as a chapter's verse.
  if (name.names.includes("toVerse") && (!name.names.includes("verse") || name.names.includes("verseInBook"))) {
    return "{toVerse} needs {verse} in the same template, and can't be used with {verseInBook}"
  }
  return { re: name.re, names: name.names }
}

export function compileTemplate(template: NameTemplate): CompiledTemplate | null {
  const compiled = compileOrWhy(template)
  return typeof compiled === "string" ? null : compiled
}

const compiledRules = new WeakMap<NamingRule, CompiledTemplate[]>()

/** A rule's templates, compiled once per rule rather than once per name. */
export function compileRule(rule: NamingRule): CompiledTemplate[] {
  let compiled = compiledRules.get(rule)
  if (!compiled) {
    compiled = rule.templates.map(compileTemplate).filter((c): c is CompiledTemplate => c !== null)
    compiledRules.set(rule, compiled)
  }
  return compiled
}

function bookCode(value: unknown): string | null {
  if (typeof value !== "string") return null
  const code = value.trim().toUpperCase()
  return BOOK_CODE_SET.has(code) ? code : null
}

/** The bulk upload's own book names: codes, English names and their short
 *  forms, Chinese names. */
const TABLE = new BookNameIndex()

/** The book the app's own table reads a word as, short forms included. */
function tableBook(word: string): string | null {
  return TABLE.lookup(word, true)?.code ?? null
}

/** A project's Bible files: the name each is called, and its book's code. */
export type ProjectBooks = ReadonlyArray<{ name: string; code: string }>

/** True when `short` starts like `long` and its letters come in `long` in order. */
function shortFormOf(short: string, long: string): boolean {
  if (short.length < 2 || short[0] !== long[0]) return false
  let at = 0
  for (const ch of short) {
    at = long.indexOf(ch, at)
    if (at < 0) return false
    at++
  }
  return true
}

/**
 * True when a book word plausibly names the book it is mapped to: the app's
 * book-name table or one of the project's own Bible files reads it as that
 * code, or it is a short form of the code or the book's English name (the
 * same first letter, then its letters in order, two at least: "Mt", "Matt",
 * "Mrk"). Anything else ("sermon" → MAT) names no book: it is a constant book
 * in disguise, and holds for the one folder it was made for (review, Oct 30).
 */
export function bookWordNames(word: string, code: string, projectBooks: ProjectBooks = []): boolean {
  if (tableBook(word) === code) return true
  const key = bookKey(word)
  if (projectBooks.some((b) => b.code.toUpperCase() === code && bookKey(b.name) === key)) return true
  return shortFormOf(key, bookKey(code)) || shortFormOf(key, bookKey(englishBookName(code)))
}

/**
 * The answer as the rule the app runs, or null when any part of it is
 * unusable. Never throws. Loose ends a model leaves are tidied the same way on
 * both sides: an empty folder means none, a null explanation means none, and a
 * long explanation is trimmed.
 */
export function parseNamingRule(value: unknown): NamingRule | null {
  try {
    return parse(value)
  } catch {
    return null
  }
}

/**
 * AQU-2496 (review, Nov 9): why `parseNamingRule` refused an answer, in a
 * sentence the assistant is told when it is asked once more. Without it the
 * same question got the same unusable answer every time. Call it only for an
 * answer `parseNamingRule` refused. Never throws, and never longer than
 * MAX_REFUSAL_CHARS.
 */
export function whyRuleRefused(value: unknown): string {
  let why: string
  try {
    why = refusal(value)
  } catch {
    why = "The answer was not in the format asked for."
  }
  return why.slice(0, MAX_REFUSAL_CHARS)
}

function refusal(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "The answer was not one JSON object in the format asked for."
  const templates = (value as Record<string, unknown>).templates
  if (!Array.isArray(templates) || templates.length < 1) return "The answer had no \"templates\" list."
  if (templates.length > 2) return `The answer had ${templates.length} templates, and at most two are allowed.`
  for (const t of templates as unknown[]) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return "Each template must be {\"pattern\": string}."
    const { pattern, folder } = t as Record<string, unknown>
    if (typeof pattern !== "string") return "Each template must be {\"pattern\": string}."
    if (folder !== undefined && folder !== null && (typeof folder !== "string" || folder.trim())) return "A template is about the file name only, never its folder."
    const compiled = compileOrWhy({ pattern })
    if (typeof compiled === "string") return `The template ${JSON.stringify(pattern.slice(0, MAX_PATTERN))} can't be used: ${compiled}.`
  }
  return "The templates were usable, but \"books\", \"book\", \"chapter\", \"file\" or \"explanation\" was not in the format asked for."
}

function parse(value: unknown): NamingRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.templates) || v.templates.length < 1 || v.templates.length > 2) return null
  const templates: NameTemplate[] = []
  for (const t of v.templates) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return null
    const { pattern, folder } = t as Record<string, unknown>
    if (typeof pattern !== "string") return null
    // The assistant never sees the folders: an answer about one isn't a
    // reading of these names. An empty folder is no folder.
    if (folder !== undefined && folder !== null && (typeof folder !== "string" || folder.trim())) return null
    const template: NameTemplate = { pattern }
    if (!compileTemplate(template)) return null
    templates.push(template)
  }
  const rule: NamingRule = { version: 1, templates }
  if (v.books !== undefined && v.books !== null) {
    if (typeof v.books !== "object" || Array.isArray(v.books)) return null
    const entries = Object.entries(v.books as Record<string, unknown>)
    if (entries.length > MAX_BOOK_WORDS) return null
    const books: Array<[string, string]> = []
    for (const [word, code] of entries) {
      const known = bookCode(code)
      if (!known || word.trim().length === 0 || word.length > 30) return null
      // A word the app already reads as another book ("Mark" → MAT) is a
      // mistake, never a naming (review, Oct 30).
      const read = tableBook(word)
      if (read && read !== known) return null
      books.push([normalizeName(word).toLowerCase(), known])
    }
    // fromEntries makes own properties, so even "__proto__" stays a plain key.
    if (books.length > 0) rule.books = Object.fromEntries(books)
  }
  if (v.book !== undefined && v.book !== null) {
    const known = bookCode(v.book)
    if (!known) return null
    rule.book = known
  }
  if (v.chapter !== undefined && v.chapter !== null) {
    if (typeof v.chapter !== "number" || !Number.isInteger(v.chapter) || v.chapter < 1 || v.chapter > 200) return null
    rule.chapter = v.chapter
  }
  if (v.file !== undefined && v.file !== null) {
    if (typeof v.file !== "string" || v.file.trim().length === 0 || v.file.length > 255) return null
    rule.file = v.file.trim()
  }
  if (v.explanation !== undefined && v.explanation !== null && typeof v.explanation !== "string") return null
  if (typeof v.explanation === "string" && v.explanation.trim()) rule.explanation = v.explanation.trim().slice(0, MAX_EXPLANATION_CHARS)
  return rule
}

/** A book word the rule maps, read without case or Unicode form; own keys only. */
export function bookForWord(rule: NamingRule, word: string): string | undefined {
  const key = normalizeName(word).toLowerCase()
  return rule.books && Object.hasOwn(rule.books, key) ? rule.books[key] : undefined
}

/**
 * Sam's call, Oct 30 (the coordinator's pick, flagged to him): a rule is kept
 * for the team only when the names themselves say the book and the chapter,
 * or the book and the verse counted through the book. A rule that leans on a
 * book, chapter or file it was told holds for the one folder it was made for;
 * kept, it would put next week's Mark 2 memos on Matthew 5 without a word.
 * So does a book word that names no book ("sermon" → MAT): every `books`
 * entry must plausibly name its book (`bookWordNames`), read with the
 * project's own Bible files when they are known. The server reads those from
 * the project's files, the browser from the same list.
 */
export function isSavableRule(rule: NamingRule, opts: { projectBooks?: ProjectBooks } = {}): boolean {
  return whyNotSavable(rule, opts) === null
}

/** Why the team may not keep a rule, whatever it placed: "fixed" when it
 *  leans on a book, chapter or file it was told, or its names don't say the
 *  book and the chapter; "bookWord" when a book word names no book. Null when
 *  the rule itself may be kept. The preview says which (Sam, Oct 30). */
export type UnsavableReason = "fixed" | "bookWord"

export function whyNotSavable(rule: NamingRule, opts: { projectBooks?: ProjectBooks } = {}): UnsavableReason | null {
  if (rule.book !== undefined || rule.chapter !== undefined || rule.file !== undefined) return "fixed"
  const sayBookAndChapter = rule.templates.every((template) => {
    const compiled = compileTemplate(template)
    if (!compiled) return false
    const says = new Set<Placeholder>(compiled.names)
    return says.has("book") && (says.has("chapter") || says.has("verseInBook"))
  })
  if (!sayBookAndChapter) return "fixed"
  if (rule.books && Object.entries(rule.books).some(([word, code]) => !bookWordNames(word, code, opts.projectBooks))) return "bookWord"
  return null
}
