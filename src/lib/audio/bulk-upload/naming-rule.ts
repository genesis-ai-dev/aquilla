// AQU-2302: when none of AQU-981's own readings fits a folder's names, the
// assistant is asked ONCE what the naming means, and answers with a small rule
// — never with assignments. The app applies the rule itself: each name the rule
// fits is rewritten into a name AQU-981's matcher already reads ("MAT 19:1",
// "MAT_1_LN619", "line 12"), and the whole folder then goes through the same
// matching, line landing and duplicate checks as any other upload. So a wrong
// rule can only produce names the matcher refuses, never a silent misplacement
// the matcher would have caught.
//
// Sam, Oct 29: "uses as little API usage as possible but does the task
// accurately and consistently". One call per new naming, a bounded sample of
// names (never the audio), a fixed answer format, at most one retry with only
// the names that failed, and the rule kept for the team under the names' shape
// so the next upload in the same naming makes no call at all.
import { BOOK_CODES, englishBookName } from "./book-names"
import { LAST_VERSES } from "./verse-counts"
import type { ProjectFileInfo } from "./match"

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
   *  "Mt" → "MAT". Keys are compared without case. */
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

const MAX_PATTERN = 120
const MAX_PLACEHOLDERS = 6

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

/**
 * A template becomes a fixed, anchored expression built only from escaped
 * literal text and the placeholder classes above — the assistant never
 * supplies a regular expression of its own. Two placeholders of the same kind
 * side by side ("{chapter}{verse}") are refused: nothing could tell where one
 * ends.
 */
function compilePart(pattern: string): { re: RegExp; names: Placeholder[] } | null {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN) return null
  const names: Placeholder[] = []
  let source = ""
  let last: "literal" | "letters" | "digits" | "any" | null = null
  let rest = pattern
  while (rest.length > 0) {
    const m = /^\{([a-zA-Z]+)\}/.exec(rest)
    if (m) {
      const name = m[1] as Placeholder
      if (!(name in PLACEHOLDERS)) return null
      const kind = name === "book" ? "letters" : name === "any" ? "any" : name === "part" ? "part" : "digits"
      const touching = last !== null && last !== "literal"
      if (touching && (last === kind || kind === "any" || last === "any" || (kind === "part" && last === "letters"))) return null
      names.push(name)
      // A part run straight on to a number can only be its letter ("4a"):
      // "121" must never split into verse 12, part 1.
      source += kind === "part" && last === "digits" ? "([a-h])" : PLACEHOLDERS[name]
      last = kind === "part" ? "letters" : kind
      rest = rest.slice(m[0].length)
      continue
    }
    const next = rest.search(/\{[a-zA-Z]+\}/)
    const literal = next < 0 ? rest : rest.slice(0, next)
    if (literal.includes("{") || literal.includes("}")) return null
    source += escapeLiteral(literal)
    last = "literal"
    rest = rest.slice(literal.length)
  }
  if (names.length === 0 || names.length > MAX_PLACEHOLDERS) return null
  return { re: new RegExp(`^${source}$`, "iu"), names }
}

export function compileTemplate(template: NameTemplate): CompiledTemplate | null {
  const name = compilePart(template.pattern)
  if (!name) return null
  const folder = template.folder ? compilePart(template.folder) : null
  if (template.folder && !folder) return null
  return { re: name.re, names: name.names, folderRe: folder?.re ?? null, folderNames: folder?.names ?? [] }
}

/** The answer as the rule the app runs, or null when any part of it is unusable. */
export function parseNamingRule(value: unknown): NamingRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.templates) || v.templates.length < 1 || v.templates.length > 2) return null
  const templates: NameTemplate[] = []
  for (const t of v.templates) {
    if (!t || typeof t !== "object") return null
    const { pattern, folder } = t as Record<string, unknown>
    if (typeof pattern !== "string" || (folder !== undefined && typeof folder !== "string")) return null
    const template: NameTemplate = folder ? { pattern, folder } : { pattern }
    if (!compileTemplate(template)) return null
    templates.push(template)
  }
  const rule: NamingRule = { version: 1, templates }
  if (v.books !== undefined) {
    if (!v.books || typeof v.books !== "object" || Array.isArray(v.books)) return null
    const books: Record<string, string> = {}
    for (const [k, code] of Object.entries(v.books as Record<string, unknown>)) {
      if (typeof code !== "string" || !BOOK_CODES.includes(code.toUpperCase()) || k.length > 30) return null
      books[k.toLowerCase()] = code.toUpperCase()
    }
    if (Object.keys(books).length > 0) rule.books = books
  }
  if (v.book !== undefined && v.book !== null) {
    if (typeof v.book !== "string" || !BOOK_CODES.includes(v.book.toUpperCase())) return null
    rule.book = v.book.toUpperCase()
  }
  if (v.chapter !== undefined && v.chapter !== null) {
    if (typeof v.chapter !== "number" || !Number.isInteger(v.chapter) || v.chapter < 1 || v.chapter > 200) return null
    rule.chapter = v.chapter
  }
  if (v.file !== undefined && v.file !== null) {
    if (typeof v.file !== "string" || v.file.trim().length === 0 || v.file.length > 255) return null
    rule.file = v.file.trim()
  }
  if (typeof v.explanation === "string" && v.explanation.trim()) rule.explanation = v.explanation.trim().slice(0, 300)
  return rule
}

function extension(name: string): string {
  const m = /(\.[A-Za-z][A-Za-z0-9]{1,4})$/.exec(name)
  return m ? m[1] : ""
}

function stemOf(name: string): string {
  const ext = extension(name)
  return ext ? name.slice(0, -ext.length) : name
}

function capture(re: RegExp, names: readonly Placeholder[], text: string): Partial<Record<Placeholder, string>> | null {
  const m = re.exec(text)
  if (!m) return null
  const out: Partial<Record<Placeholder, string>> = {}
  names.forEach((name, i) => { out[name] = m[i + 1] })
  return out
}

/**
 * The name the rule makes of one recording, for AQU-981's matcher to read, or
 * null when no template fits it. The original extension is kept, so the
 * matcher's own format checks still apply.
 */
export function applyNamingRule(rule: NamingRule, fileName: string, folderName = ""): string | null {
  const stem = stemOf(fileName)
  for (const template of rule.templates) {
    const compiled = compileTemplate(template)
    if (!compiled) continue
    const values = capture(compiled.re, compiled.names, stem)
    if (!values) continue
    if (compiled.folderRe) {
      const fromFolder = capture(compiled.folderRe, compiled.folderNames, folderName)
      if (!fromFolder) continue
      for (const [k, val] of Object.entries(fromFolder)) values[k as Placeholder] ??= val
    }
    const bookText = values.book?.trim()
    const code = bookText ? (rule.books?.[bookText.toLowerCase()] ?? bookText) : rule.book
    const chapter = values.chapter ?? (rule.chapter != null ? String(rule.chapter) : undefined)
    const suffix = [
      values.part != null ? ` part ${values.part}` : "",
      values.take != null ? ` take ${Number(values.take)}` : "",
    ].join("")
    let made: string | null = null
    if (values.verseInBook != null && code) {
      made = values.verse != null ? `${code}_${Number(values.verse)}_LN${Number(values.verseInBook)}` : `${code}_LN${Number(values.verseInBook)}`
    } else if (code && chapter != null && values.verse != null) {
      made = `${code} ${Number(chapter)}:${Number(values.verse)}`
    } else if (code && chapter != null) {
      made = `${code} ${Number(chapter)}`
    } else if (values.line != null) {
      made = rule.file ? `${rule.file} line ${Number(values.line)}` : `line ${Number(values.line)}`
    }
    if (made) return `${made}${suffix}${extension(fileName)}`
  }
  return null
}

/** The names' shape, digits blanked: "MAT_1_LN619.ogg" → "mat_#_ln#.ogg". The
 *  team's saved rules are kept under it. */
export function nameShape(fileName: string): string {
  const name = fileName.normalize("NFKC").toLowerCase()
  const ext = extension(name)
  return `${stemOf(name).replace(/\d+/g, "#")}${ext}`
}

/** The shapes of a list of names, most common first. */
export function shapesOf(names: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const n of names) counts.set(nameShape(n), (counts.get(nameShape(n)) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s)
}

export const SAMPLE_SIZE = 30

/**
 * At most 30 names that cover the folder, chosen the same way every time: the
 * first and last few, an even spread between, and the names whose shape is
 * not the folder's usual one (the odd ones out are where a naming breaks).
 */
export function sampleNames(names: readonly string[], size = SAMPLE_SIZE): string[] {
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (sorted.length <= size) return sorted
  const picked = new Set<string>()
  const usual = shapesOf(sorted)[0]
  for (const n of sorted) {
    if (picked.size >= 8) break
    if (nameShape(n) !== usual) picked.add(n)
  }
  for (const n of [...sorted.slice(0, 3), ...sorted.slice(-3)]) picked.add(n)
  // An even spread over what's left; a step that lands on a name already
  // taken moves on to the next one.
  const room = size - picked.size
  for (let i = 0; i < room && picked.size < size; i++) {
    let at = Math.floor(((i + 0.5) * sorted.length) / room)
    while (at < sorted.length - 1 && picked.has(sorted[at])) at++
    picked.add(sorted[at])
  }
  for (const n of sorted) {
    if (picked.size >= size) break
    picked.add(n)
  }
  return sorted.filter((n) => picked.has(n))
}

/**
 * What the assistant is told about the project, compactly: each Bible book's
 * code and its verses per chapter, and every other file's name. Lines and text
 * never leave the browser.
 */
export function projectOutline(files: readonly ProjectFileInfo[]): string {
  const lines: string[] = []
  for (const f of files) {
    if (f.bookCode) {
      const counts = LAST_VERSES[f.bookCode]
      lines.push(`${f.bookCode} (${englishBookName(f.bookCode)}): ${counts ? `verses per chapter ${counts.join(",")}` : "verse counts unknown"}`)
    } else {
      lines.push(`File: ${JSON.stringify(f.name)}`)
    }
  }
  return lines.slice(0, 80).join("\n")
}

/** A name the rule failed on, and why the matcher refused what it made. */
export interface RuleFailure {
  name: string
  made: string | null
  reason: string
}
