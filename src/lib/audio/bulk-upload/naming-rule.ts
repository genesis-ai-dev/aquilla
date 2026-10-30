// AQU-2302: when none of AQU-981's own readings fits a folder's names, the
// assistant may be asked what the naming means, and answers with a small rule
// — never with assignments. The app applies the rule itself: each name the rule
// fits is rewritten into a name AQU-981's matcher already reads ("MAT 19:1",
// "MAT_1_LN619", "line 12"), and the whole folder then goes through the same
// matching, line landing and duplicate checks as any other upload.
//
// That keeps the matcher's own refusals (a verse the book lacks, another book's
// name, a range backwards), but it does NOT make a wrong rule harmless: a rule
// that reads the numbers in the wrong order makes names the matcher reads
// perfectly well ("MAT 5:1 take 2" for what was verse 2). So the preview shows
// every row "by the assistant's rule", nothing is saved until the person
// confirms, and a rule is kept for the team only when `judgeRule` finds it
// placed every name by reading it, made no two files takes of one line, and
// leans on no book, chapter or file it was told (review, Oct 30). Pieces of a
// line ("v04a", "v04b", or verses 4 and 5 of a joined 4-5) are not takes, and
// don't stop the keep (Sam, Oct 30).
//
// Sam, Oct 29: "uses as little API usage as possible but does the task
// accurately and consistently". At most two calls per folder, a bounded sample
// of names (never the audio), a fixed answer format, the retry with only the
// names that failed, and the rule kept for the team under the names' shape so
// the next upload in the same naming makes no call at all.
//
// The rule's format and its checks live in shared/recording-naming-rule.ts,
// which the auth worker uses too.
import {
  bookForWord,
  compileRule,
  isSavableRule,
  MAX_OUTLINE_CHARS,
  normalizeName,
  type NamingRule,
  type Placeholder,
} from "../../../../shared/recording-naming-rule"
import { englishBookName } from "./book-names"
import { LAST_VERSES } from "./verse-counts"
import { piecesOfOneLine, type Assignment, type ProjectFileInfo, type UnmatchedReason } from "./match"

export {
  compileRule,
  compileTemplate,
  isSavableRule,
  parseNamingRule,
  type CompiledTemplate,
  type NameTemplate,
  type NamingRule,
  type Placeholder,
} from "../../../../shared/recording-naming-rule"

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
  // One Unicode form for every name: "versículo" typed on a Mac (decomposed)
  // reads like the same word typed anywhere else, and "１２" like "12".
  const name = normalizeName(fileName)
  const folder = normalizeName(folderName)
  const stem = stemOf(name)
  for (const compiled of compileRule(rule)) {
    const values = capture(compiled.re, compiled.names, stem)
    if (!values) continue
    if (compiled.folderRe) {
      const fromFolder = capture(compiled.folderRe, compiled.folderNames, folder)
      if (!fromFolder) continue
      for (const [k, val] of Object.entries(fromFolder)) values[k as Placeholder] ??= val
    }
    const bookText = values.book?.trim()
    const code = bookText ? (bookForWord(rule, bookText) ?? bookText) : rule.book
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
    if (made) return `${made}${suffix}${extension(name)}`
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
  let size = 0
  for (const f of files) {
    if (lines.length >= 80) break
    let line: string
    if (f.bookCode) {
      const counts = LAST_VERSES[f.bookCode]
      line = `${f.bookCode} (${englishBookName(f.bookCode)}): ${counts ? `verses per chapter ${counts.join(",")}` : "verse counts unknown"}`
    } else {
      line = `File: ${JSON.stringify(f.name)}`
    }
    // Whole lines only, and never past what the server takes: a line that
    // doesn't fit is left out, and shorter ones after it may still go.
    const grows = line.length + (lines.length > 0 ? 1 : 0)
    if (size + grows > MAX_OUTLINE_CHARS) continue
    lines.push(line)
    size += grows
  }
  return lines.join("\n")
}

/** A name the rule failed on, and why the matcher refused what it made. */
export interface RuleFailure {
  name: string
  made: string | null
  reason: string
}

/** What the person or the file itself decided, which no rule may rewrite:
 *  981's deliberate refusals, a file the person skipped, and anything that
 *  isn't a recording at all. */
const NOT_FOR_RULE: ReadonlySet<UnmatchedReason["code"]> = new Set([
  "notAudio", "unplayableFormat", "systemFile", "empty", "tooLarge",
  "noSuchVerse", "noSuchBookVerse", "otherBook", "duplicate", "bookVerseDisagree", "rangeBackwards", "rangeOnTimedFile",
  "skipped",
])

/** True when this file's name may go to the assistant and be rewritten by its
 *  rule: 981 placed it nowhere, because it couldn't read the name. */
export function ruleEligible(a: Assignment): boolean {
  if (a.cellIds && a.cellIds.length > 0) return false
  return !a.reason || !NOT_FOR_RULE.has(a.reason.code)
}

export interface RuleJudgement {
  /** The names the matcher placed by reading the rule's name for them. */
  placed: ReadonlySet<number>
  /** The names it was asked about and didn't place, leaving out what the
   *  person chose or skipped by hand: what the one retry sends back. */
  failures: RuleFailure[]
  /** True when the team may keep the rule for the next folder named this way. */
  keep: boolean
}

/**
 * How a rule did on the names it was asked about, after the matcher read them.
 * A name counts as placed only when the matcher placed it by reading the
 * rule's name, never by folder order, and not when the person chose or
 * corrected its line by hand. The rule is kept only when every name was placed
 * that way, it leans on no constant (`isSavableRule`), and no two files share
 * a line unless they are its pieces. Two files on the very same spot, with no
 * part telling them apart, are takes of one another: what a rule with the take
 * and the verse swapped makes of a whole folder, so that isn't kept. Pieces
 * are told apart by their part, the matcher's own way (`piecesOfOneLine`):
 * "v04a" and "v04b", and verses 4 and 5 landing on a joined line 4-5, which
 * the matcher joins as that line's pieces just as it would for any upload
 * (Sam, Oct 30).
 */
export function judgeRule(
  rule: NamingRule,
  eligible: ReadonlySet<number>,
  made: ReadonlyMap<number, string>,
  assignments: readonly Assignment[],
  nameOf: (index: number) => string,
): RuleJudgement {
  const byIndex = new Map(assignments.map((a) => [a.index, a]))
  const placed = new Set<number>()
  const failures: RuleFailure[] = []
  const lines = new Map<string, Assignment[]>()
  let shared = false
  for (const index of eligible) {
    const a = byIndex.get(index)
    if (a?.cellIds?.length && !a.chosen && a.method !== "order" && made.has(index)) {
      placed.add(index)
      for (const cellId of a.cellIds) {
        const key = `${a.fileId}\u0000${cellId}`
        const held = lines.get(key) ?? []
        if (held.some((h) => !piecesOfOneLine(h, a))) shared = true
        lines.set(key, [...held, a])
      }
      continue
    }
    if (a?.chosen || a?.reason?.code === "skipped") continue
    failures.push({ name: nameOf(index), made: made.get(index) ?? null, reason: a?.method === "order" ? "byOrder" : a?.reason?.code ?? "noTemplate" })
  }
  const keep = eligible.size > 0 && placed.size === eligible.size && !shared && isSavableRule(rule)
  return { placed, failures, keep }
}
