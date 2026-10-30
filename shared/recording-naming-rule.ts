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

/** One way the names are written. `pattern` is matched against the file name
 *  without its extension; `folder`, when set, against the folder it sits in. */
export interface NameTemplate {
  pattern: string
  folder?: string
}

export interface NamingRule {
  version: 1
  /** One template, or two when the folder mixes two namings. */
  templates: NameTemplate[]
  /** What the `{book}` text means, when it isn't a book name the app knows:
   *  "mt" → "MAT". Keys are kept in lower case. */
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
  book: "([1-3]?\\s?[\\p{L}][\\p{L}.']{0,29}?)",
  chapter: "(\\d{1,3})",
  verse: "(\\d{1,3})",
  verseInBook: "(\\d{1,5})",
  line: "(\\d{1,5})",
  take: "(\\d{1,2})",
  part: "(\\d{1,2}|[a-h])",
  any: "(.*?)",
} as const
export type Placeholder = keyof typeof PLACEHOLDERS

function isPlaceholder(name: string): name is Placeholder {
  // Own keys only: "{constructor}" must never reach Object.prototype.
  return Object.hasOwn(PLACEHOLDERS, name)
}

export interface CompiledTemplate {
  re: RegExp
  folderRe: RegExp | null
  /** Placeholder names in capture order, for the name then the folder. */
  names: Placeholder[]
  folderNames: Placeholder[]
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
 *   - text to ignore beside any placeholder, or more than two of it.
 * A part run straight on to a number can only be its letter ("4a").
 */
function compilePart(raw: string): { re: RegExp; names: Placeholder[] } | null {
  const pattern = normalizeName(raw)
  if (pattern.length === 0 || pattern.length > MAX_PATTERN) return null
  const names: Placeholder[] = []
  let source = ""
  let last: Kind | null = null
  let rest = pattern
  while (rest.length > 0) {
    const m = /^\{([a-zA-Z_]+)\}/.exec(rest)
    if (m) {
      const name = m[1]
      if (!isPlaceholder(name)) return null
      const kind: Kind = name === "book" ? "letters" : name === "any" ? "any" : name === "part" ? "part" : "digits"
      if (last !== null && last !== "literal") {
        if (last === kind || kind === "any" || last === "any") return null
        if (kind === "part" && last === "letters") return null
        if ((kind === "digits" || kind === "letters") && last === "part") return null
      }
      names.push(name)
      source += kind === "part" && last === "digits" ? "([a-h])" : PLACEHOLDERS[name]
      last = kind
      rest = rest.slice(m[0].length)
      continue
    }
    const next = rest.search(/\{[a-zA-Z_]+\}/)
    const literal = next < 0 ? rest : rest.slice(0, next)
    if (literal.includes("{") || literal.includes("}")) return null
    source += escapeLiteral(literal)
    last = "literal"
    rest = rest.slice(literal.length)
  }
  if (names.length === 0 || names.length > MAX_PLACEHOLDERS) return null
  if (names.filter((n) => n === "any").length > MAX_ANY) return null
  try {
    return { re: new RegExp(`^${source}$`, "iu"), names }
  } catch {
    return null
  }
}

export function compileTemplate(template: NameTemplate): CompiledTemplate | null {
  const name = compilePart(template.pattern)
  if (!name) return null
  const folder = template.folder ? compilePart(template.folder) : null
  if (template.folder && !folder) return null
  return { re: name.re, names: name.names, folderRe: folder?.re ?? null, folderNames: folder?.names ?? [] }
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

function parse(value: unknown): NamingRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.templates) || v.templates.length < 1 || v.templates.length > 2) return null
  const templates: NameTemplate[] = []
  for (const t of v.templates) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return null
    const { pattern, folder } = t as Record<string, unknown>
    if (typeof pattern !== "string") return null
    if (folder !== undefined && folder !== null && typeof folder !== "string") return null
    const template: NameTemplate = typeof folder === "string" && folder.trim() ? { pattern, folder } : { pattern }
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
 */
export function isSavableRule(rule: NamingRule): boolean {
  if (rule.book !== undefined || rule.chapter !== undefined || rule.file !== undefined) return false
  return rule.templates.every((template) => {
    const compiled = compileTemplate(template)
    if (!compiled) return false
    const says = new Set<Placeholder>([...compiled.names, ...compiled.folderNames])
    return says.has("book") && (says.has("chapter") || says.has("verseInBook"))
  })
}
