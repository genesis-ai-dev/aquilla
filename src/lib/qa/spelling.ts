/**
 * Project wordlist and spelling suspicion (AQU-1737) — Paratext parity for
 * Wordlist + spell check, "Approve spelling of common words", and Find
 * Similar Words, without Paratext's per-project dictionary setup.
 *
 * Paratext asks a project to carry a hand-curated dictionary before its spell
 * check says anything useful. These languages mostly have no dictionary to
 * import, so this module derives the wordlist from the target text itself and
 * decides what is a misspelling from FREQUENCY: a form the project writes
 * often is that project's spelling, and a one-off form that is a near or
 * sound-alike variant of a common one is a suspected typo of it.
 *
 * Pure, locale-less, no I/O — same contract as `capitalization.ts` (AQU-1734),
 * and the same reason: findings are CODES + raw word forms, never sentences,
 * so the render site translates. A word form in a finding is cell content and
 * is never translated.
 *
 * ## Why frequency, and why corpus-scoped
 *
 * Nothing inside a single cell can tell "Yeesu" (a typo) from "Yeesu" (this
 * project's spelling of a name). Only how often each form recurs across the
 * corpus can — exactly the argument `capitalization.ts` makes for its
 * mixed-case scan. So this scan runs where a corpus is in hand (the
 * deterministic "Check file" pass, `src/lib/check/deterministic-check.ts`) and
 * never on the per-keystroke path.
 *
 * ## What is never flagged
 *
 *  - A form at or above `approveAtOccurrences` (Paratext's "Approve spelling
 *    of common words", default 100). It is reported as auto-approved so a
 *    reviewer can see what was let through, rather than silently passing.
 *  - A form the SOURCE text already writes that way: a name or brand carried
 *    over from the source is not the translator's spelling.
 *  - A form a reviewer has approved. Approval is per form, and a finding
 *    carries every cell the form occurs in, so approving clears every
 *    occurrence at once rather than cell by cell.
 *  - A pair differing only by case (`yesu` / `Yesu`). That is the
 *    capitalization check's finding; reporting it here too would double-report
 *    one problem.
 *  - Forms shorter than `MIN_FORM_LENGTH`. At two letters almost every form is
 *    one edit from another and the check becomes noise.
 */

/** One cell a word form occurs in. */
export interface WordlistCellRef {
  cellId: string
  cellLabel?: string
}

/** One form in the project wordlist, with where and how often it occurs. */
export interface WordlistEntry {
  /** The word form, verbatim — raw cell content, never translated. */
  form: string
  /** Total occurrences across the scanned corpus (not distinct cells). */
  occurrences: number
  /** Distinct cells the form occurs in, in first-seen order. */
  cells: WordlistCellRef[]
  /** The cell the form was first seen in — Paratext's "first seen" column. */
  firstSeenCellId: string
}

/** A form frequent enough to be treated as correct without review. */
export interface AutoApprovedSpelling {
  form: string
  occurrences: number
}

/** Why a rare form is suspected of being a misspelling of `suggestion`. */
export type SpellingSuspicion =
  /** The two forms fold to the same sound-alike key (`Yeesu` → `Yesu`). */
  | "sound-alike"
  /** The two forms are within `maxDistance` edits of each other. */
  | "near-match"

/** One suspected misspelling, grouped by form so it is reported once. */
export interface SpellingFinding {
  /** The suspected form, verbatim — raw cell content, never translated. */
  form: string
  occurrences: number
  /** The common form offered as the correct spelling, verbatim. */
  suggestion: string
  suggestionOccurrences: number
  reason: SpellingSuspicion
  /** Every cell the suspected form occurs in — approving clears them all. */
  cells: WordlistCellRef[]
}

/** A sound-alike group, Paratext's "Find Similar Words". */
export interface SimilarWordGroup {
  /** The shared sound-alike key — an internal fold, never shown to a user. */
  key: string
  /** The group's forms, most frequent first. */
  forms: WordlistEntry[]
}

export interface SpellingScanOptions {
  /**
   * Paratext's "Approve spelling of common words" threshold: a form occurring
   * this many times is correct without review. Paratext's default is 100.
   */
  approveAtOccurrences?: number
  /** Occurrences up to which a form is rare enough to suspect. */
  maxSuspectOccurrences?: number
  /** Occurrences a form needs before it may be offered as the correct one. */
  minCommonOccurrences?: number
  /** Forms a reviewer has approved; their findings are cleared outright. */
  approved?: ReadonlySet<string>
  /** Forms the source text writes — never the translator's spelling. */
  sourceForms?: ReadonlySet<string>
}

/** Paratext's documented default for "Approve spelling of common words". */
export const DEFAULT_APPROVE_AT_OCCURRENCES = 100
/** A form has to be a one-off before it is suspected. */
export const DEFAULT_MAX_SUSPECT_OCCURRENCES = 1
/** The project has to write a form this often before it can be the suggestion. */
export const DEFAULT_MIN_COMMON_OCCURRENCES = 3
/** Below this length, "one edit away" stops meaning anything. */
export const MIN_FORM_LENGTH = 3

/** Same word shape as `capitalization.ts`, so both scans agree on what a word is. */
const WORD_RE = /[\p{L}\p{M}'’-]+/gu

/** Apostrophes and hyphens join word parts; they never start or end a word. */
const TRIM_RE = /^['’-]+|['’-]+$/gu

// ---------------------------------------------------------------------------
// Sound-alike folding
// ---------------------------------------------------------------------------

/**
 * Latin sound-alike classes. Applied in order on a lowercased, mark-stripped
 * form, digraphs first so `sh` is one sound rather than `s` + `h`.
 *
 * Deliberately short: each entry is a confusion that actually recurs in these
 * projects' Latin orthographies (the ticket's own example is the s/sh/z
 * class). A longer table would start merging words that are genuinely
 * different, and a false "did you mean" is worse than a missed one — the
 * reviewer stops trusting the list.
 */
const LATIN_SOUND_CLASSES: readonly [RegExp, string][] = [
  [/ph/g, "f"],
  [/sh/g, "s"],
  [/zh/g, "s"],
  [/ch/g, "c"],
  [/th/g, "t"],
  [/ck/g, "k"],
  [/kh/g, "k"],
  [/gh/g, "g"],
  [/z/g, "s"],
  [/q/g, "k"],
  [/w/g, "v"],
  [/x/g, "ks"],
]

const LATIN_RE = /\p{Script=Latin}/u

/** Strip combining marks so `é` folds to `e` (NFD, then drop `\p{M}`). */
function stripMarks(word: string): string {
  return word.normalize("NFD").replace(/\p{M}+/gu, "")
}

/** Collapse runs of the same character: `Yeesu` → `yesu`, `missisipi` stays. */
function collapseRuns(word: string): string {
  let out = ""
  for (const ch of word) {
    if (ch !== out[out.length - 1]) out += ch
  }
  return out
}

/**
 * The sound-alike key two forms share when they plausibly sound the same.
 *
 * Script-aware rather than script-blind: the consonant classes above are
 * claims about Latin orthography and would be nonsense applied to Arabic or
 * Devanagari. A form with no Latin letters gets the script-neutral fold only
 * (case, combining marks, repeated characters) — honest about what this
 * module knows, instead of inventing rules for a script it has none for.
 */
export function soundAlikeKey(word: string): string {
  const base = collapseRuns(stripMarks(word.toLowerCase()).replace(TRIM_RE, ""))
  if (!LATIN_RE.test(base)) return base
  let folded = base
  for (const [re, to] of LATIN_SOUND_CLASSES) folded = folded.replace(re, to)
  return collapseRuns(folded)
}

/** Case- and mark-insensitive identity, for "differ only by case" pairs. */
function caseFold(word: string): string {
  return stripMarks(word.toLowerCase())
}

// ---------------------------------------------------------------------------
// Wordlist
// ---------------------------------------------------------------------------

export interface SpellableCell {
  id: string
  cellLabel?: string
  /** The target text to build the wordlist from. */
  translated: string
}

/** Every word form in `text`, trimmed, skipping USFM markers (`\p`, `\zaln-s`). */
export function wordsIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(WORD_RE)) {
    if (m.index === undefined) continue
    if (text[m.index - 1] === "\\") continue // markup, not a word
    const form = m[0].replace(TRIM_RE, "")
    if (form.length > 0) out.push(form)
  }
  return out
}

/**
 * Build the project wordlist from the scanned cells' target text.
 *
 * Keyed on the verbatim form, so `Yesu` and `yesu` are two entries: a
 * wordlist that folded case could not show a reviewer which spelling the
 * project actually writes. Sorted most frequent first, then alphabetically,
 * so the list reads as "the project's vocabulary" top-down.
 */
export function buildWordlist(cells: readonly SpellableCell[]): WordlistEntry[] {
  const byForm = new Map<string, WordlistEntry>()
  for (const cell of cells) {
    if (!cell.translated.trim()) continue
    for (const form of wordsIn(cell.translated)) {
      const entry = byForm.get(form)
      if (entry) {
        entry.occurrences++
        if (entry.cells[entry.cells.length - 1]?.cellId !== cell.id
          && !entry.cells.some((c) => c.cellId === cell.id)) {
          entry.cells.push({ cellId: cell.id, cellLabel: cell.cellLabel })
        }
      } else {
        byForm.set(form, {
          form,
          occurrences: 1,
          cells: [{ cellId: cell.id, cellLabel: cell.cellLabel }],
          firstSeenCellId: cell.id,
        })
      }
    }
  }
  return [...byForm.values()].sort(
    (a, b) => b.occurrences - a.occurrences || a.form.localeCompare(b.form),
  )
}

/**
 * Paratext's "Find Similar Words": the wordlist grouped by sound-alike key,
 * keeping only the keys at least two distinct forms share. Most-populated
 * group first, so the biggest spelling split in the project reads at the top.
 */
export function findSimilarWordGroups(
  wordlist: readonly WordlistEntry[],
): SimilarWordGroup[] {
  const byKey = new Map<string, WordlistEntry[]>()
  for (const entry of wordlist) {
    if (entry.form.length < MIN_FORM_LENGTH) continue
    const key = soundAlikeKey(entry.form)
    if (!key) continue
    const list = byKey.get(key)
    if (list) list.push(entry)
    else byKey.set(key, [entry])
  }
  const groups: SimilarWordGroup[] = []
  for (const [key, forms] of byKey) {
    // One form written two ways is a group; one form written one way is not.
    if (new Set(forms.map((f) => caseFold(f.form))).size < 2) continue
    groups.push({
      key,
      forms: [...forms].sort(
        (a, b) => b.occurrences - a.occurrences || a.form.localeCompare(b.form),
      ),
    })
  }
  return groups.sort(
    (a, b) => b.forms.length - a.forms.length || a.key.localeCompare(b.key),
  )
}

// ---------------------------------------------------------------------------
// Suspicion
// ---------------------------------------------------------------------------

/** Edits allowed between a suspected form and its suggestion, by length. */
export function maxDistanceFor(form: string): number {
  return form.length >= 8 ? 2 : 1
}

/**
 * Levenshtein distance, abandoned as soon as it exceeds `max` (returns
 * `max + 1`). Bounded because the only question asked of it is "within max?",
 * and a full matrix over a whole wordlist is work nobody reads.
 */
export function editDistanceAtMost(a: string, b: string, max: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1)
    row[0] = i
    let best = i
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      if (row[j] < best) best = row[j]
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length]
}

/** Every form reachable by deleting one character, plus the form itself. */
function deletionVariants(word: string): string[] {
  const out = [word]
  for (let i = 0; i < word.length; i++) {
    out.push(word.slice(0, i) + word.slice(i + 1))
  }
  return out
}

interface SuspicionMatch {
  entry: WordlistEntry
  reason: SpellingSuspicion
  distance: number
}

/**
 * The match that best explains a suspected form. Sound-alike beats near-match
 * (sharing a fold key is the stronger claim, and it is the one a reviewer can
 * read), then the fewest edits, then the most-written suggestion.
 */
function bestMatch(matches: readonly SuspicionMatch[]): SuspicionMatch | null {
  let best: SuspicionMatch | null = null
  for (const m of matches) {
    if (best === null) { best = m; continue }
    if (m.reason !== best.reason) {
      if (m.reason === "sound-alike") best = m
      continue
    }
    if (m.distance < best.distance) { best = m; continue }
    if (m.distance === best.distance && m.entry.occurrences > best.entry.occurrences) best = m
  }
  return best
}

/**
 * Suspected misspellings in the wordlist, one finding per suspected form.
 *
 * A rare form is suspected when a form the project writes often is either its
 * sound-alike twin or within `maxDistanceFor` edits of it. Sound-alike wins
 * when both hold: sharing a fold key is the stronger claim, and it is the one
 * that explains the finding to a reviewer.
 *
 * Candidates are matched against the common forms through a deletion index
 * (the SymSpell trick: two forms within 2 edits always share a 1-deletion
 * variant), so the scan is linear in the wordlist's total length rather than
 * quadratic in its size.
 */
export function findSuspectedMisspellings(
  wordlist: readonly WordlistEntry[],
  opts: SpellingScanOptions = {},
): SpellingFinding[] {
  const approveAt = opts.approveAtOccurrences ?? DEFAULT_APPROVE_AT_OCCURRENCES
  const maxSuspect = opts.maxSuspectOccurrences ?? DEFAULT_MAX_SUSPECT_OCCURRENCES
  const minCommon = opts.minCommonOccurrences ?? DEFAULT_MIN_COMMON_OCCURRENCES
  const approved = opts.approved
  const sourceForms = opts.sourceForms

  const sourceFolded = new Set<string>()
  if (sourceForms) for (const f of sourceForms) sourceFolded.add(caseFold(f))

  const eligible = wordlist.filter((e) => e.form.length >= MIN_FORM_LENGTH)
  const commons = eligible.filter((e) => e.occurrences >= minCommon)

  const byKey = new Map<string, WordlistEntry[]>()
  const byDeletion = new Map<string, WordlistEntry[]>()
  for (const entry of commons) {
    const key = soundAlikeKey(entry.form)
    const keyed = byKey.get(key)
    if (keyed) keyed.push(entry)
    else byKey.set(key, [entry])
    for (const variant of deletionVariants(caseFold(entry.form))) {
      const list = byDeletion.get(variant)
      if (list) list.push(entry)
      else byDeletion.set(variant, [entry])
    }
  }

  const findings: SpellingFinding[] = []
  for (const candidate of eligible) {
    if (candidate.occurrences > maxSuspect) continue
    if (candidate.occurrences >= approveAt) continue
    if (approved?.has(candidate.form)) continue
    if (sourceFolded.has(caseFold(candidate.form))) continue

    const folded = caseFold(candidate.form)
    const max = maxDistanceFor(candidate.form)

    const matches: SuspicionMatch[] = []
    const consider = (entry: WordlistEntry, reason: SpellingSuspicion, distance: number): void => {
      // A pair differing only by case is the capitalization check's finding.
      if (caseFold(entry.form) === folded) return
      // The suggestion has to be the more-written form, or the check would
      // propose a one-off as the correction for another one-off.
      if (entry.occurrences <= candidate.occurrences) return
      matches.push({ entry, reason, distance })
    }

    for (const entry of byKey.get(soundAlikeKey(candidate.form)) ?? []) {
      consider(entry, "sound-alike", editDistanceAtMost(folded, caseFold(entry.form), max))
    }
    const seen = new Set<string>()
    for (const variant of deletionVariants(folded)) {
      for (const entry of byDeletion.get(variant) ?? []) {
        if (seen.has(entry.form)) continue
        seen.add(entry.form)
        const distance = editDistanceAtMost(folded, caseFold(entry.form), max)
        if (distance <= max) consider(entry, "near-match", distance)
      }
    }

    const best = bestMatch(matches)
    if (!best) continue
    findings.push({
      form: candidate.form,
      occurrences: candidate.occurrences,
      suggestion: best.entry.form,
      suggestionOccurrences: best.entry.occurrences,
      reason: best.reason,
      cells: candidate.cells,
    })
  }

  // Most-confident first: the more often the project writes the suggestion,
  // the likelier the one-off beside it is a slip.
  return findings.sort(
    (a, b) => b.suggestionOccurrences - a.suggestionOccurrences || a.form.localeCompare(b.form),
  )
}

/** Forms frequent enough to be approved without review, most frequent first. */
export function autoApprovedSpellings(
  wordlist: readonly WordlistEntry[],
  opts: SpellingScanOptions = {},
): AutoApprovedSpelling[] {
  const approveAt = opts.approveAtOccurrences ?? DEFAULT_APPROVE_AT_OCCURRENCES
  return wordlist
    .filter((e) => e.occurrences >= approveAt)
    .map((e) => ({ form: e.form, occurrences: e.occurrences }))
    .sort((a, b) => b.occurrences - a.occurrences || a.form.localeCompare(b.form))
}

/**
 * Approve one spelling: the form joins the approved set, and every finding
 * for it — all of its occurrences at once — is gone from the next
 * `withoutApprovedSpellings` result. One reviewer decision per FORM, never
 * per cell: the same slip in forty cells is one judgement, and asking for it
 * forty times is how a spell check stops being used.
 */
export function approveSpelling(
  approved: ReadonlySet<string>,
  form: string,
): Set<string> {
  const next = new Set(approved)
  next.add(form)
  return next
}

/** The findings left once the approved forms are cleared. */
export function withoutApprovedSpellings(
  findings: readonly SpellingFinding[],
  approved: ReadonlySet<string>,
): SpellingFinding[] {
  if (approved.size === 0) return [...findings]
  return findings.filter((f) => !approved.has(f.form))
}
