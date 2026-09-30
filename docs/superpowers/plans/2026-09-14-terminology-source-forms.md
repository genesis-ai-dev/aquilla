# Terminology Source-Form Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a terminology source term match inflected, affixed, and differently-pointed occurrences through user-enabled options (mark folding, project affix inventory, wildcards, explicit forms, exclusions), and show users which surface forms actually matched.

**Architecture:** One concept-aware matcher (`match.ts`) builds a single regex per concept; every consumer calls it. Options live on `Concept.match` (per term) and `ProjectWideSettings.termMatching` (per project affix inventory), both resolved by one pure function. Folding is expressed inside the regex so match offsets stay in the original text. Discovered forms are derived on read from the cells a caller already holds.

**Tech Stack:** TypeScript, React 19, vitest (happy-dom), Playwright, Postgres via Hyperdrive (sync-worker), TanStack Form, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-09-14-terminology-source-forms-design.md`

**Ticket:** AQU-1271

## Global Constraints

- No `any`. ES6+. Files under ~500 lines; split when a file you touch would cross it.
- Vitest root suite excludes workers; sync-worker tests run with `cd sync-worker && npm test`.
- Every new i18n key goes in `src/lib/i18n/namespaces/terminology.ts` (or `projectSettings.ts`) in BOTH the strings object and the metadata object with a `description`. Other locales fall back to English; do not edit them.
- `term.*` events name exactly one concept. `term.update` is a partial patch: absent key = leave column alone.
- Existing terms must match everything they matched before (backward compatibility is asserted in tests).
- Tests encode WHY (a `// WHY:` comment per test, matching `match.test.ts` style).
- Commit after each task with the ticket in the message body: `Refs AQU-1271`.

---

### Task 1: Types, option resolver, affix presets

**Files:**
- Modify: `src/lib/terminology/types.ts`
- Create: `src/lib/terminology/match-options.ts`
- Create: `src/lib/terminology/affix-presets.ts`
- Modify: `src/lib/sync/project-settings.ts` (add `termMatching?` to `ProjectWideSettings`, near `targetLanes`)
- Modify: `src/lib/parsers/types.ts` (add `termMatching?` to `ProjectRecord`, near `targetLanes`)
- Modify: `src/hooks/useProject.ts:59` (add `assign("termMatching", settings.termMatching)`)
- Test: `src/lib/terminology/match-options.test.ts`

**Interfaces:**
- Produces:
  - `TermMatchOptions { foldMarks?: boolean; affixes?: boolean; forms?: string[]; excludedForms?: string[] }`
  - `TermMatchingSettings { prefixes: string[]; suffixes: string[]; maxAffixes?: number; foldMarksDefault?: boolean }`
  - `Concept.match?: TermMatchOptions`
  - `ResolvedMatchOptions { foldMarks: boolean; affixes: boolean; forms: string[]; excludedForms: string[]; prefixes: string[]; suffixes: string[]; maxAffixes: number }`
  - `resolveMatchOptions(concept: Pick<Concept, "sourceTerm" | "match">, project?: TermMatchingSettings): ResolvedMatchOptions`
  - `hasCombiningMarks(s: string): boolean`
  - `AFFIX_PRESETS: ReadonlyArray<{ id: string; labelKey: MessageKey; prefixes: string[]; suffixes: string[] }>`

- [ ] **Step 1: Add the types**

In `src/lib/terminology/types.ts`, after `TermRendering`:

```ts
/**
 * Per-concept matching options. Every field is optional; absent fields resolve
 * to script- and project-derived defaults in `resolveMatchOptions`
 * (match-options.ts). Stored verbatim in `concepts.match_options`.
 */
export interface TermMatchOptions {
  /** Ignore combining marks (vowel points, accents) on both sides. */
  foldMarks?: boolean
  /** Allow the project's configured prefixes/suffixes around the term. */
  affixes?: boolean
  /** Extra literal source forms treated as alternates of sourceTerm. */
  forms?: string[]
  /** Matched surface forms the user rejected; compared after folding. */
  excludedForms?: string[]
}

/**
 * Project-level affix inventory for source-term matching. Plain data: the
 * matcher knows "prefix strings" and "suffix strings", nothing about any
 * language. Presets (affix-presets.ts) only pre-fill these lists.
 */
export interface TermMatchingSettings {
  prefixes: string[]
  suffixes: string[]
  /** Chained affixes allowed per side. Default 2. */
  maxAffixes?: number
  /** Overrides the script-derived foldMarks default for every concept. */
  foldMarksDefault?: boolean
}
```

Add to `Concept`:

```ts
  /** Matching options; see TermMatchOptions. Absent = all defaults. */
  match?: TermMatchOptions
```

Add to `ConceptDraft`:

```ts
  match?: TermMatchOptions
```

In `src/lib/sync/project-settings.ts` `ProjectWideSettings`, after `archivedLanes?`:

```ts
  /**
   * AQU-1271: project affix inventory for terminology source-term matching.
   * Replacing this key replaces the whole object.
   */
  termMatching?: import("@/lib/terminology/types").TermMatchingSettings
```

In `src/lib/parsers/types.ts` `ProjectRecord`, after `archivedLanes?`:

```ts
  /** AQU-1271: overlaid from ProjectWideSettings.termMatching by useProject. */
  termMatching?: import("@/lib/terminology/types").TermMatchingSettings
```

In `src/hooks/useProject.ts` after `assign("terminology", settings.terminology)`:

```ts
  assign("termMatching", settings.termMatching)
```

- [ ] **Step 2: Write the failing resolver test**

`src/lib/terminology/match-options.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { hasCombiningMarks, resolveMatchOptions } from "./match-options"

describe("resolveMatchOptions", () => {
  // WHY: the whole point of script-derived defaults is that a user who selects
  // pointed Hebrew gets mark-tolerant matching without finding a checkbox.
  it("folds marks by default when the term carries combining marks", () => {
    expect(resolveMatchOptions({ sourceTerm: "הָאָ֗רֶץ" }).foldMarks).toBe(true)
    expect(resolveMatchOptions({ sourceTerm: "grace" }).foldMarks).toBe(false)
  })

  // WHY: Latin diacritics (é, ñ) are letters that matter; folding must not
  // silently turn on for them. NFD splits é into e + mark, so we check the
  // NFC-composed form first and only look at marks that survive composition.
  it("does not treat precomposed Latin diacritics as combining marks", () => {
    expect(hasCombiningMarks("café")).toBe(false)
    expect(hasCombiningMarks("Español")).toBe(false)
    expect(hasCombiningMarks("בְּרֵאשִׁית")).toBe(true)
  })

  // WHY: an explicit per-concept choice must beat every default.
  it("explicit concept options win over defaults", () => {
    expect(resolveMatchOptions({ sourceTerm: "הָאָ֗רֶץ", match: { foldMarks: false } }).foldMarks).toBe(false)
    expect(resolveMatchOptions({ sourceTerm: "grace", match: { foldMarks: true } }).foldMarks).toBe(true)
  })

  // WHY: the project-level default is the admin's override for a whole
  // termbase; it sits between the script default and the per-concept choice.
  it("project foldMarksDefault beats the script default but not the concept", () => {
    const project = { prefixes: [], suffixes: [], foldMarksDefault: true }
    expect(resolveMatchOptions({ sourceTerm: "grace" }, project).foldMarks).toBe(true)
    expect(resolveMatchOptions({ sourceTerm: "grace", match: { foldMarks: false } }, project).foldMarks).toBe(false)
  })

  // WHY: affixes default on only when there is an inventory to apply; with an
  // empty inventory the flag is meaningless and must resolve false so the
  // regex builder never emits an empty alternation.
  it("affixes default to whether the project has an inventory", () => {
    expect(resolveMatchOptions({ sourceTerm: "x" }).affixes).toBe(false)
    expect(resolveMatchOptions({ sourceTerm: "x" }, { prefixes: ["ו"], suffixes: [] }).affixes).toBe(true)
    expect(resolveMatchOptions({ sourceTerm: "x", match: { affixes: false } }, { prefixes: ["ו"], suffixes: [] }).affixes).toBe(false)
  })

  // WHY: consumers iterate these; they must never be undefined.
  it("always returns arrays and a numeric maxAffixes", () => {
    const r = resolveMatchOptions({ sourceTerm: "x" })
    expect(r.forms).toEqual([])
    expect(r.excludedForms).toEqual([])
    expect(r.prefixes).toEqual([])
    expect(r.suffixes).toEqual([])
    expect(r.maxAffixes).toBe(2)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test src/lib/terminology/match-options.test.ts`
Expected: FAIL, module `./match-options` not found.

- [ ] **Step 4: Implement the resolver**

`src/lib/terminology/match-options.ts`:

```ts
/**
 * Resolve a concept's effective matching options from three layers:
 *   concept.match (explicit) > project.termMatching defaults > script-derived.
 *
 * Pure. Every consumer of the matcher goes through here so chips, rules,
 * stats, and the term page never disagree about what a term matches.
 */

import type { Concept, TermMatchingSettings } from "./types"

export const DEFAULT_MAX_AFFIXES = 2

export interface ResolvedMatchOptions {
  foldMarks: boolean
  affixes: boolean
  forms: string[]
  excludedForms: string[]
  prefixes: string[]
  suffixes: string[]
  maxAffixes: number
}

/**
 * True when the string contains combining marks that survive NFC composition
 * (Hebrew niqqud/cantillation, Arabic harakat, Syriac points). Precomposed
 * Latin letters like é compose back to a single code point and do not count.
 */
export function hasCombiningMarks(s: string): boolean {
  return /\p{M}/u.test(s.normalize("NFC"))
}

export function resolveMatchOptions(
  concept: Pick<Concept, "sourceTerm" | "match">,
  project?: TermMatchingSettings,
): ResolvedMatchOptions {
  const prefixes = (project?.prefixes ?? []).filter((p) => p.length > 0)
  const suffixes = (project?.suffixes ?? []).filter((s) => s.length > 0)
  const hasInventory = prefixes.length > 0 || suffixes.length > 0

  const foldMarks =
    concept.match?.foldMarks ??
    project?.foldMarksDefault ??
    hasCombiningMarks(concept.sourceTerm)

  const affixes = hasInventory && (concept.match?.affixes ?? true)

  return {
    foldMarks,
    affixes,
    forms: (concept.match?.forms ?? []).map((f) => f.trim()).filter((f) => f.length > 0),
    excludedForms: (concept.match?.excludedForms ?? []).map((f) => f.trim()).filter((f) => f.length > 0),
    prefixes,
    suffixes,
    maxAffixes: project?.maxAffixes ?? DEFAULT_MAX_AFFIXES,
  }
}
```

- [ ] **Step 5: Add the presets file**

`src/lib/terminology/affix-presets.ts`:

```ts
/**
 * Starting-point affix inventories a project admin can load into
 * ProjectWideSettings.termMatching. Data only — nothing at match time reads
 * this file. Lists are editable after loading; a preset is a suggestion.
 */

import type { MessageKey } from "@/lib/i18n/messages/en"

export interface AffixPreset {
  id: string
  labelKey: MessageKey
  prefixes: string[]
  suffixes: string[]
}

export const AFFIX_PRESETS: ReadonlyArray<AffixPreset> = [
  {
    id: "hebrew",
    labelKey: "projectSettings.termMatching.preset.hebrew",
    // Inseparable prefixes: conjunction, article, prepositions, relative.
    prefixes: ["ו", "ה", "ב", "כ", "ל", "מ", "ש"],
    // Plural/dual endings and pronominal suffixes.
    suffixes: ["ים", "ות", "יִם", "י", "ך", "ו", "ה", "נו", "כם", "כן", "הם", "הן"],
  },
  {
    id: "arabic",
    labelKey: "projectSettings.termMatching.preset.arabic",
    prefixes: ["و", "ف", "ب", "ك", "ل", "ال", "س"],
    suffixes: ["ات", "ون", "ين", "ة", "ي", "ك", "ه", "ها", "نا", "كم", "هم"],
  },
  {
    id: "swahili",
    labelKey: "projectSettings.termMatching.preset.swahili",
    prefixes: ["wa", "m", "mi", "ki", "vi", "ma", "ji", "u", "ku", "pa"],
    suffixes: ["ni", "ji"],
  },
  {
    id: "turkish",
    labelKey: "projectSettings.termMatching.preset.turkish",
    prefixes: [],
    suffixes: ["lar", "ler", "ı", "i", "u", "ü", "da", "de", "ta", "te", "dan", "den", "ın", "in", "un", "ün", "a", "e", "ya", "ye"],
  },
]
```

Add to `src/lib/i18n/namespaces/projectSettings.ts` strings object:

```ts
    "projectSettings.termMatching.preset.hebrew": "Hebrew",
    "projectSettings.termMatching.preset.arabic": "Arabic",
    "projectSettings.termMatching.preset.swahili": "Swahili",
    "projectSettings.termMatching.preset.turkish": "Turkish",
```

and to its metadata object, each with `{ description: "Name of a language whose affix preset can be loaded into the terminology matching settings." }`.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm test src/lib/terminology/match-options.test.ts && pnpm tsc -b --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/terminology/types.ts src/lib/terminology/match-options.ts src/lib/terminology/match-options.test.ts src/lib/terminology/affix-presets.ts src/lib/sync/project-settings.ts src/lib/parsers/types.ts src/hooks/useProject.ts src/lib/i18n/namespaces/projectSettings.ts
git commit -m "feat(terminology): TermMatchOptions, project affix inventory, option resolver

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Matcher, part 1: mark folding and mark-spanning wildcard

**Files:**
- Modify: `src/lib/terminology/match.ts`
- Test: `src/lib/terminology/match.test.ts`

**Interfaces:**
- Produces: `termToRegexSource(term: string, opts?: TermRegexOptions): string | null` where `TermRegexOptions { foldMarks?: boolean; prefixes?: string[]; suffixes?: string[]; maxAffixes?: number }` (prefixes/suffixes implemented in Task 3; accepted here so the signature is final).
- `buildTermRegex(term, flags = "iu", opts?: TermRegexOptions)`.
- `matchesTerm(haystack, term, opts?: { caseSensitive?: boolean } & TermRegexOptions)`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/terminology/match.test.ts`:

```ts
describe("mark folding (foldMarks)", () => {
  const term = "הָאָ֗רֶץ" // as selected in Gen 1:1, with revia accent

  // WHY: the bug that started AQU-1271. A term selected with one accent must
  // match the same word under another accent, or with no accent at all.
  it("matches the same consonants under different pointing", () => {
    expect(matchesTerm("הָאָ֑רֶץ", term, { foldMarks: true })).toBe(true)
    expect(matchesTerm("הָאָרֶץ", term, { foldMarks: true })).toBe(true)
    expect(matchesTerm("הארץ", term, { foldMarks: true })).toBe(true)
  })

  // WHY: without folding, behaviour must be byte-exact as before, so turning
  // the option off restores the old semantics for projects that rely on it.
  it("without foldMarks the old exact-pointing behaviour stands", () => {
    expect(matchesTerm("הָאָ֑רֶץ", term)).toBe(false)
    expect(matchesTerm(term, term)).toBe(true)
  })

  // WHY: editor decorations use match offsets. Folding must be done inside the
  // regex so the match spans the original pointed text, not a stripped copy.
  it("reports offsets in the original (pointed) haystack", () => {
    const hay = "בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָֽרֶץ׃"
    const re = buildTermRegex(term, "giu", { foldMarks: true })!
    const m = re.exec(hay)!
    expect(hay.slice(m.index, m.index + m[0].length)).toBe("הָאָֽרֶץ")
  })

  // WHY: the sheva before ה is a mark, so the leading boundary already passed
  // on וְהָאָ֗רֶץ by accident. With folding that accident must not become a
  // regression in the other direction: a plain consonantal ו IS a letter and
  // must block the match until affixes (Task 3) allow it.
  it("a prefixed consonant still blocks the leading boundary", () => {
    expect(matchesTerm("והארץ", term, { foldMarks: true })).toBe(false)
  })
})

describe("wildcard spans marks", () => {
  // WHY: `*` used to expand to letters only, so `הָאָ*` stopped at the first
  // vowel point. A wildcard is "the rest of the word", marks included.
  it("`*` consumes letters and combining marks", () => {
    expect(matchesTerm("הָאָ֗רֶץ", "הָאָ*")).toBe(true)
    // Backward compat: Latin inflection unchanged.
    expect(matchesTerm("graced", "grac*")).toBe(true)
    expect(matchesTerm("grid", "grac*")).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/lib/terminology/match.test.ts`
Expected: FAIL on the folding cases (option ignored) and the wildcard-with-marks case.

- [ ] **Step 3: Implement folding and the widened wildcard**

Replace the body of `src/lib/terminology/match.ts` from `const LEAD_BOUNDARY` through `matchesTerm` with:

```ts
const LEAD_BOUNDARY = "(?<!\\p{L})"
const TRAIL_BOUNDARY = "(?!\\p{L})"
/** A wildcard `*` expands to the rest of an inflected word: letters AND marks. */
const WILDCARD = "[\\p{L}\\p{M}]*"
/** Zero-or-more combining marks; interleaved after every literal char when folding. */
const MARKS = "\\p{M}*"

export interface TermRegexOptions {
  /** Ignore combining marks on both sides (see file header). */
  foldMarks?: boolean
  /** Project affix inventory; only used when non-empty. */
  prefixes?: string[]
  suffixes?: string[]
  /** Chained affixes allowed per side (default 2). */
  maxAffixes?: number
}

/** NFD, drop every combining mark, NFC. */
export function stripMarks(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC")
}

/**
 * Escape a literal segment for the regex. When folding, marks are removed from
 * the segment and `\p{M}*` is emitted after every remaining character, so the
 * pattern matches the pointed original at its true offsets.
 */
function literalSegment(seg: string, foldMarks: boolean): string {
  if (!foldMarks) return escapeRegex(seg)
  return Array.from(stripMarks(seg))
    .map((ch) => escapeRegex(ch) + MARKS)
    .join("")
}

/**
 * Convert a user term into a regex source string with inflectional wildcard,
 * word-boundary, optional mark-folding and optional affix semantics.
 * Returns `null` for empty / whitespace-only terms (nothing to match).
 */
export function termToRegexSource(term: string, opts: TermRegexOptions = {}): string | null {
  const trimmed = term.trim()
  if (!trimmed) return null
  const fold = opts.foldMarks === true

  const hasLeadingStar = trimmed.startsWith("*")
  const hasTrailingStar = trimmed.endsWith("*")

  const body = trimmed
    .split("*")
    .map((seg) => literalSegment(seg, fold))
    .join(WILDCARD)

  const lead = hasLeadingStar ? "" : LEAD_BOUNDARY + affixGroup(opts.prefixes, opts.maxAffixes, fold, "prefix")
  const trail = hasTrailingStar ? "" : affixGroup(opts.suffixes, opts.maxAffixes, fold, "suffix") + TRAIL_BOUNDARY
  return `${lead}${body}${trail}`
}

/**
 * Bounded alternation of affixes. Returns "" when the list is empty so a term
 * with no inventory compiles exactly as before. Longest first so `ים` is
 * preferred over `י` when both could match.
 */
function affixGroup(
  affixes: string[] | undefined,
  maxAffixes: number | undefined,
  fold: boolean,
  side: "prefix" | "suffix",
): string {
  const list = (affixes ?? []).map((a) => a.trim()).filter((a) => a.length > 0)
  if (list.length === 0) return ""
  const alts = [...new Set(list)]
    .sort((a, b) => b.length - a.length)
    .map((a) => literalSegment(a, fold))
    .join("|")
  const n = Math.max(1, Math.min(maxAffixes ?? 2, 4))
  // A prefix is followed by the marks that sit on its last letter; a suffix is
  // preceded by the marks sitting on the stem's last letter. When folding the
  // literalSegment already emits trailing \p{M}*, so only the suffix side needs
  // the leading run.
  return side === "prefix" ? `(?:(?:${alts})${fold ? "" : MARKS}){0,${n}}` : `(?:${MARKS}(?:${alts})){0,${n}}`
}

/**
 * Build a RegExp for a term. Returns `null` for empty/whitespace terms.
 * Default flags: case-insensitive + Unicode. Add `g` for global scanning.
 */
export function buildTermRegex(term: string, flags = "iu", opts?: TermRegexOptions): RegExp | null {
  const src = termToRegexSource(term, opts)
  if (src === null) return null
  return new RegExp(src, flags)
}

/** True if `haystack` contains a match for `term` (Unicode; case-insensitive unless asked). */
export function matchesTerm(
  haystack: string,
  term: string,
  opts?: { caseSensitive?: boolean } & TermRegexOptions,
): boolean {
  if (!haystack) return false
  const flags = opts?.caseSensitive ? "u" : "iu"
  const re = buildTermRegex(term, flags, opts)
  return re !== null && re.test(haystack)
}
```

Update the file header comment: change the wildcard paragraph to say `*` expands to `[\p{L}\p{M}]*`, and add a "Mark folding" paragraph describing `literalSegment`. Keep the existing `escapeRegex`.

- [ ] **Step 4: Run the full matcher suite**

Run: `pnpm test src/lib/terminology/match.test.ts`
Expected: PASS, including every pre-existing test (backward compatibility).

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminology/match.ts src/lib/terminology/match.test.ts
git commit -m "feat(terminology): mark-folding matcher and mark-spanning wildcard

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Matcher, part 2: affixes, forms, exclusions, concept entry points

**Files:**
- Modify: `src/lib/terminology/match.ts`
- Test: `src/lib/terminology/match.test.ts`

**Interfaces:**
- Consumes: `resolveMatchOptions` (Task 1), `termToRegexSource` with affix options (Task 2).
- Produces:
  - `conceptToRegexSource(concept: Pick<Concept,"sourceTerm"|"match">, project?: TermMatchingSettings, opts?: { includeExcluded?: boolean }): string | null`
  - `buildConceptRegex(concept, project?, flags = "iu", opts?)`
  - `matchesConcept(haystack: string, concept: Pick<Concept,"sourceTerm"|"match"|"caseSensitive">, project?: TermMatchingSettings): boolean`
  - `findConceptMatches(haystack, concept, project?, opts?: { includeExcluded?: boolean }): Array<{ start: number; end: number; surface: string }>`

- [ ] **Step 1: Write the failing tests**

Append to `match.test.ts`:

```ts
import { conceptToRegexSource, findConceptMatches, matchesConcept } from "./match"

describe("affixes", () => {
  const project = { prefixes: ["ו", "ה", "ב", "כ", "ל", "מ"], suffixes: ["ים", "י"], maxAffixes: 2 }
  const concept = { sourceTerm: "הָאָ֗רֶץ" }

  // WHY: the user's Gen 1:1 case. Prefixed forms must match once the project
  // says which prefixes exist; the code knows nothing about Hebrew.
  it("matches prefixed forms from the project inventory", () => {
    expect(matchesConcept("וְהָאָ֗רֶץ", concept, project)).toBe(true)
    expect(matchesConcept("והארץ", concept, project)).toBe(true)
    // ב replaces ה here (בָּאָ֣רֶץ has no article), so it must NOT match this term.
    expect(matchesConcept("בָּאָ֣רֶץ", concept, project)).toBe(false)
  })

  // WHY: chaining is bounded so a long run of prefix letters cannot swallow an
  // unrelated word that merely ends in the term.
  it("respects maxAffixes", () => {
    const one = { ...project, maxAffixes: 1 }
    expect(matchesConcept("ולהארץ", concept, one)).toBe(false)
    expect(matchesConcept("ולהארץ", concept, project)).toBe(true)
  })

  // WHY: per-concept opt-out. A proper noun should not absorb prefixes even in
  // an affix-heavy project.
  it("a concept can opt out with match.affixes=false", () => {
    expect(matchesConcept("והארץ", { ...concept, match: { affixes: false } }, project)).toBe(false)
  })

  // WHY: Latin suffixes, to prove nothing is script-specific.
  it("works for Latin suffix inventories", () => {
    const en = { prefixes: [], suffixes: ["s", "es", "ed", "ing"] }
    expect(matchesConcept("the graces", { sourceTerm: "grace" }, en)).toBe(true)
    expect(matchesConcept("disgrace", { sourceTerm: "grace" }, en)).toBe(false)
  })
})

describe("forms and exclusions", () => {
  // WHY: manual variants are the escape hatch when no option covers a form.
  it("match.forms are alternates with their own boundaries", () => {
    const c = { sourceTerm: "אֶרֶץ", match: { forms: ["אָרֶץ"] } }
    expect(matchesConcept("הָאָרֶץ", c, { prefixes: ["ה"], suffixes: [] })).toBe(true)
  })

  // WHY: the discovered-forms chip UX writes excludedForms; excluding a surface
  // form must remove it everywhere the matcher is used (rules, chips, counts).
  it("excludedForms suppress a whole surface form", () => {
    const project = { prefixes: ["ו", "ה"], suffixes: [] }
    const c = { sourceTerm: "הארץ", match: { excludedForms: ["והארץ"] } }
    expect(matchesConcept("הארץ", c, project)).toBe(true)
    expect(matchesConcept("והארץ", c, project)).toBe(false)
    // Exclusion is compared folded when foldMarks is on.
    const pointed = { sourceTerm: "הָאָ֗רֶץ", match: { excludedForms: ["וְהָאָ֗רֶץ"] } }
    expect(matchesConcept("וְהָאָֽרֶץ", pointed, project)).toBe(false)
  })

  // WHY: discoverForms needs to list excluded forms so they can be re-included.
  it("findConceptMatches can include excluded forms on request", () => {
    const project = { prefixes: ["ו"], suffixes: [] }
    const c = { sourceTerm: "הארץ", match: { excludedForms: ["והארץ"] } }
    expect(findConceptMatches("והארץ הארץ", c, project).map((m) => m.surface)).toEqual(["הארץ"])
    expect(findConceptMatches("והארץ הארץ", c, project, { includeExcluded: true }).map((m) => m.surface)).toEqual(["והארץ", "הארץ"])
  })

  // WHY: regex-injection safety extends to forms, affixes and exclusions.
  it("escapes regex metacharacters in forms, affixes and exclusions", () => {
    const c = { sourceTerm: "a.b", match: { forms: ["c+d"], excludedForms: ["(x)"] } }
    expect(matchesConcept("axb", c, { prefixes: ["["], suffixes: [] })).toBe(false)
    expect(matchesConcept("c+d", c)).toBe(true)
    expect(conceptToRegexSource(c)).not.toBeNull()
  })

  // WHY: compile.ts hands the rule engine ONE sourcePattern; everything above
  // must be expressible as a single regex source.
  it("conceptToRegexSource returns a single compilable pattern", () => {
    const src = conceptToRegexSource(
      { sourceTerm: "הָאָ֗רֶץ", match: { forms: ["אֶרֶץ"], excludedForms: ["והארץ"] } },
      { prefixes: ["ו", "ה"], suffixes: ["ים"] },
    )!
    expect(() => new RegExp(src, "giu")).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/lib/terminology/match.test.ts`
Expected: FAIL, `conceptToRegexSource` etc. not exported.

- [ ] **Step 3: Implement the concept-level builder**

Append to `match.ts`:

```ts
import type { Concept, TermMatchingSettings } from "./types"
import { resolveMatchOptions } from "./match-options"

type ConceptLike = Pick<Concept, "sourceTerm" | "match"> & { caseSensitive?: boolean }

export interface ConceptRegexOpts {
  /** Skip the exclusion lookahead so excluded surface forms still match. */
  includeExcluded?: boolean
}

/**
 * One regex source for a whole concept: sourceTerm + match.forms as
 * alternates, each with boundaries and affix groups; excludedForms as a
 * leading negative lookahead anchored at the same word start.
 */
export function conceptToRegexSource(
  concept: ConceptLike,
  project?: TermMatchingSettings,
  opts: ConceptRegexOpts = {},
): string | null {
  const r = resolveMatchOptions(concept, project)
  const termOpts: TermRegexOptions = {
    foldMarks: r.foldMarks,
    ...(r.affixes ? { prefixes: r.prefixes, suffixes: r.suffixes, maxAffixes: r.maxAffixes } : {}),
  }
  const alts = [concept.sourceTerm, ...r.forms]
    .map((t) => termToRegexSource(t, termOpts))
    .filter((p): p is string => p !== null)
  if (alts.length === 0) return null
  const body = alts.length === 1 ? alts[0] : `(?:${alts.join("|")})`

  if (opts.includeExcluded || r.excludedForms.length === 0) return body
  const excl = r.excludedForms
    .map((f) => literalSegment(f, r.foldMarks))
    .join("|")
  // Anchored where the match would start: not preceded by a letter, and the
  // excluded surface must end at a word boundary so `הארץ` excludes only the
  // whole word, never a longer word that begins with it.
  return `(?!(?:${excl})${TRAIL_BOUNDARY})${body}`
}

export function buildConceptRegex(
  concept: ConceptLike,
  project?: TermMatchingSettings,
  flags = "iu",
  opts?: ConceptRegexOpts,
): RegExp | null {
  const src = conceptToRegexSource(concept, project, opts)
  return src === null ? null : new RegExp(src, flags)
}

export function matchesConcept(haystack: string, concept: ConceptLike, project?: TermMatchingSettings): boolean {
  if (!haystack) return false
  const re = buildConceptRegex(concept, project, concept.caseSensitive ? "u" : "iu")
  return re !== null && re.test(haystack)
}

export interface ConceptMatch {
  start: number
  end: number
  surface: string
}

/** Every non-overlapping match with [start,end) offsets in the ORIGINAL text. */
export function findConceptMatches(
  haystack: string,
  concept: ConceptLike,
  project?: TermMatchingSettings,
  opts?: ConceptRegexOpts,
): ConceptMatch[] {
  if (!haystack) return []
  const re = buildConceptRegex(concept, project, concept.caseSensitive ? "gu" : "giu", opts)
  if (!re) return []
  const out: ConceptMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(haystack)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1
      continue
    }
    out.push({ start: m.index, end: m.index + m[0].length, surface: m[0] })
  }
  return out
}
```

Move the `import` lines to the top of the file with the other imports. Note `literalSegment` and `TRAIL_BOUNDARY` are module-private and already defined above.

- [ ] **Step 4: Run tests**

Run: `pnpm test src/lib/terminology/match.test.ts`
Expected: PASS.

If the `maxAffixes: 1` test fails because `ו` then `ל` then `ה`: three prefixes on `ולהארץ`, and the term is `הארץ` which starts with `ה`, so the prefixes consumed are `ו`,`ל` (two). With `maxAffixes: 1` it must fail, with 2 pass. That is what the test asserts.

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminology/match.ts src/lib/terminology/match.test.ts
git commit -m "feat(terminology): concept-level matcher with affixes, forms and exclusions

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Discovered forms

**Files:**
- Create: `src/lib/terminology/discover-forms.ts`
- Test: `src/lib/terminology/discover-forms.test.ts`

**Interfaces:**
- Consumes: `findConceptMatches` (Task 3), `resolveMatchOptions`, `stripMarks`.
- Produces:
  - `DiscoveredForm { surface: string; count: number; excluded: boolean; sampleCellIds: string[] }`
  - `discoverForms(cells: ReadonlyArray<{ id: string; original: string }>, concept, project?, opts?: { maxSamples?: number }): DiscoveredForm[]`
  - `countConceptOccurrences(cells, concept, project?): number` (cells with at least one non-excluded match).
  - `formKey(surface: string, foldMarks: boolean, caseSensitive: boolean): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { countConceptOccurrences, discoverForms } from "./discover-forms"

const cells = [
  { id: "c1", original: "בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָֽרֶץ׃" },
  { id: "c2", original: "וְהָאָ֗רֶץ הָיְתָה תֹ֙הוּ֙ וָבֹ֔הוּ" },
  { id: "c3", original: "וַיִּקְרָ֨א אֱלֹהִ֤ים ׀ לַיַּבָּשָׁה֙ אֶ֔רֶץ" },
  { id: "c4", original: "וְהָאָרֶץ again" },
]
const project = { prefixes: ["ו", "ה", "ב"], suffixes: [] }
const concept = { sourceTerm: "הָאָ֗רֶץ" }

describe("discoverForms", () => {
  // WHY: this list IS the UX. The user learns what "matching" means by seeing
  // the forms it caught, grouped by surface string, most common first.
  it("groups matched surface forms with counts, most frequent first", () => {
    const forms = discoverForms(cells, concept, project)
    expect(forms.map((f) => [f.surface, f.count])).toEqual([
      ["וְהָאָ֗רֶץ", 1],
      ["וְהָאָרֶץ", 1],
      ["הָאָֽרֶץ", 1],
    ].sort((a, b) => (b[1] as number) - (a[1] as number)) )
    expect(forms.every((f) => f.sampleCellIds.length === 1)).toBe(true)
  })

  // WHY: an excluded form must still be listed (flagged) so it can be
  // re-included from the same chip.
  it("flags excluded forms instead of hiding them", () => {
    const forms = discoverForms(cells, { ...concept, match: { excludedForms: ["וְהָאָ֗רֶץ"] } }, project)
    const ex = forms.filter((f) => f.excluded).map((f) => f.surface).sort()
    // Folded comparison: both וְהָאָ֗רֶץ and וְהָאָרֶץ fold to והארץ.
    expect(ex).toEqual(["וְהָאָ֗רֶץ", "וְהָאָרֶץ"].sort())
    expect(forms.find((f) => f.surface === "הָאָֽרֶץ")?.excluded).toBe(false)
  })

  // WHY: the popover's "matches N places" is a cell count, not a hit count,
  // and must not count cells whose only hits are excluded.
  it("countConceptOccurrences counts cells with a live match", () => {
    expect(countConceptOccurrences(cells, concept, project)).toBe(3)
    expect(countConceptOccurrences(cells, { ...concept, match: { excludedForms: ["והארץ"] } }, project)).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/lib/terminology/discover-forms.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Discovered forms — the distinct surface strings a concept's matcher actually
 * hits in a set of cells. Derived on read; no persistence. Callers pass the
 * cells they already hold (term page: project cells; editor popover: the open
 * file's cells).
 */

import type { Concept, TermMatchingSettings } from "./types"
import { findConceptMatches, stripMarks } from "./match"
import { resolveMatchOptions } from "./match-options"

export interface DiscoveredForm {
  surface: string
  count: number
  excluded: boolean
  sampleCellIds: string[]
}

type ConceptLike = Pick<Concept, "sourceTerm" | "match"> & { caseSensitive?: boolean }
type CellLike = { id: string; original: string }

/** Comparison key for a surface form under the concept's options. */
export function formKey(surface: string, foldMarks: boolean, caseSensitive: boolean): string {
  const folded = foldMarks ? stripMarks(surface) : surface.normalize("NFC")
  return caseSensitive ? folded : folded.toLowerCase()
}

export function discoverForms(
  cells: ReadonlyArray<CellLike>,
  concept: ConceptLike,
  project?: TermMatchingSettings,
  opts: { maxSamples?: number } = {},
): DiscoveredForm[] {
  const maxSamples = opts.maxSamples ?? 3
  const r = resolveMatchOptions(concept, project)
  const caseSensitive = concept.caseSensitive === true
  const excludedKeys = new Set(r.excludedForms.map((f) => formKey(f, r.foldMarks, caseSensitive)))
  const byNfc = new Map<string, DiscoveredForm>()

  for (const cell of cells) {
    for (const m of findConceptMatches(cell.original, concept, project, { includeExcluded: true })) {
      const surface = m.surface.normalize("NFC")
      let entry = byNfc.get(surface)
      if (!entry) {
        entry = {
          surface,
          count: 0,
          excluded: excludedKeys.has(formKey(surface, r.foldMarks, caseSensitive)),
          sampleCellIds: [],
        }
        byNfc.set(surface, entry)
      }
      entry.count += 1
      if (entry.sampleCellIds.length < maxSamples && !entry.sampleCellIds.includes(cell.id)) {
        entry.sampleCellIds.push(cell.id)
      }
    }
  }

  return [...byNfc.values()].sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface))
}

/** Cells with at least one live (non-excluded) match. */
export function countConceptOccurrences(
  cells: ReadonlyArray<CellLike>,
  concept: ConceptLike,
  project?: TermMatchingSettings,
): number {
  let n = 0
  for (const cell of cells) {
    if (findConceptMatches(cell.original, concept, project).length > 0) n += 1
  }
  return n
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/lib/terminology/discover-forms.test.ts`
Expected: PASS. If the first test's ordering assertion is brittle (all counts are 1, so order falls to `localeCompare`), replace the `toEqual` with a set comparison on surfaces plus `expect(forms.every(f => f.count === 1))`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminology/discover-forms.ts src/lib/terminology/discover-forms.test.ts
git commit -m "feat(terminology): discoverForms and countConceptOccurrences

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Migrate every source-side consumer to the concept matcher

**Files:**
- Modify: `src/lib/terminology/compile.ts` (signature `compileConceptsToRules(concepts, termMatching?)`)
- Modify: `src/hooks/useRules.ts:135`, `src/components/TerminologyViolationsInbox.tsx:44` (pass `project.termMatching`)
- Modify: `src/lib/terminology/stats.ts` (`computeTerminologyStats` gains `termMatching?` param; internal source match uses `matchesConcept`)
- Modify: `src/lib/terminology/preacceptance.ts:48` (`detectPreAcceptanceWarnings` gains `termMatching?`; source check uses `matchesConcept`)
- Modify: `src/lib/check/deterministic-check.ts:119,244` (`scanTermConsistency(cells, concepts, termMatching?)`; `sourceRe = buildConceptRegex(concept, termMatching)`)
- Modify: `src/lib/richtext/terminology-chip-plugin.ts` (`findTermMatches` keeps its signature for renderings; add `findConceptMatchRanges(text, concept, termMatching)` used at line 65; extension options gain `getTermMatching?: () => TermMatchingSettings | undefined`)
- Modify: `src/components/TerminologyTermDetail.tsx:110,343` (use `matchesConcept(original, concept, termMatching)`; new prop `termMatching?: TermMatchingSettings`)
- Modify: `src/components/TerminologyPage.tsx:1243` (pass `termMatching={project?.termMatching}`)
- Modify: `src/lib/terminology/candidates.ts:471` (managed-term exclusion: `managedConcepts.some(c => matchesConcept(candidate, c, termMatching))`; adjust caller signature accordingly)
- Test: `src/lib/terminology/terminology.test.ts` (compile), `src/lib/terminology/stats.test.ts`

**Interfaces:**
- Consumes: Task 3 exports.
- Produces: the new optional trailing `termMatching?: TermMatchingSettings` parameter on `compileConceptsToRules`, `computeTerminologyStats`, `detectPreAcceptanceWarnings`, `scanTermConsistency`; `findConceptMatchRanges`.

- [ ] **Step 1: Write the failing compile test**

Append to `src/lib/terminology/terminology.test.ts` inside `describe("compileConceptsToRules")`:

```ts
  // WHY: enforcement must see the same forms the term page and chips see. If
  // compile bypassed the concept matcher, a term would count as "enforced" on
  // the glossary page while the rule engine silently skipped prefixed cells.
  it("source pattern honours foldMarks, affixes, forms and exclusions", () => {
    const concept: Concept = {
      id: "c-erets",
      sourceTerm: "הָאָ֗רֶץ",
      renderings: [{ rendering: "earth", status: "preferred" }],
      status: "active",
      createdAt: new Date().toISOString(),
      match: { excludedForms: ["בארץ"] },
    }
    const [rule] = compileConceptsToRules([concept], { prefixes: ["ו", "ה", "ב"], suffixes: [] })
    const re = new RegExp((rule.check as { sourcePattern: string }).sourcePattern, "giu")
    expect(re.test("וְהָאָ֗רֶץ")).toBe(true)
    re.lastIndex = 0
    expect(re.test("הָאָֽרֶץ׃")).toBe(true)
    re.lastIndex = 0
    expect(re.test("בָּאָ֣רֶץ")).toBe(false)
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/lib/terminology/terminology.test.ts`
Expected: FAIL (second argument ignored, prefixed form not matched).

- [ ] **Step 3: Update compile.ts**

```ts
import { conceptToRegexSource, termToRegexSource } from "./match"
import type { Concept, TermMatchingSettings } from "./types"

export function compileConceptsToRules(
  concepts: Concept[],
  termMatching?: TermMatchingSettings,
): TranslationRule[] {
  // …
    const sourcePattern = conceptToRegexSource(concept, termMatching)
    if (sourcePattern === null) continue
```

Renderings keep `termToRegexSource(r.rendering)`.

- [ ] **Step 4: Update the other consumers**

`stats.ts`: add `termMatching?: TermMatchingSettings` as the last parameter of `computeTerminologyStats` and thread it to wherever the source text is tested; replace that test with `matchesConcept(effectiveSourceText(pair), concept, termMatching)`. Target-side rendering checks stay on `matchesTerm`.

`preacceptance.ts:48`: `if (!matchesConcept(sourceText, concept, termMatching)) continue`, with `termMatching?` added to the function's options/params.

`deterministic-check.ts`: `scanTermConsistency(cells, concepts, termMatching?)`; line 119 becomes `const sourceRe = buildConceptRegex(concept, termMatching)`; line 244 passes `input.termMatching` (add `termMatching?: TermMatchingSettings` to the input type).

`terminology-chip-plugin.ts`: add

```ts
export function findConceptMatchRanges(
  text: string,
  concept: Concept,
  termMatching?: TermMatchingSettings,
): Array<{ start: number; end: number }> {
  return findConceptMatches(text, concept, termMatching).map(({ start, end }) => ({ start, end }))
}
```

Use it at line 65 (`findConceptMatchRanges(plainText, concept, getTermMatching?.())`). `buildTerminologyChipDecorationSet(doc, concepts, termMatching?)`; the extension's options gain `getTermMatching?: () => TermMatchingSettings | undefined` and pass it through at lines 95, 98, 104. Find the extension's consumer (`grep -rn "terminologyConcepts" src/components/TranslatedEditor*.tsx src/components/EditorTable.tsx`) and add a `termMatching` prop beside `terminologyConcepts`, sourced from `project.termMatching`.

`TerminologyTermDetail.tsx`: add prop `termMatching?: TermMatchingSettings`; line 110 and 343 use `matchesConcept(original, concept, termMatching)`; thread `termMatching` into `deriveVerdict`'s signature. `TerminologyPage.tsx:1243` passes `termMatching={project?.termMatching}`.

`candidates.ts:471`: the managed-term exclusion currently receives `managedTerms: string[]`. Change the parameter to `managedConcepts: Concept[]` plus `termMatching?` and test with `matchesConcept(candidate, c, termMatching)`. Update its caller (grep `managedTerms` in `src/lib/terminology/candidates-worker.ts` and `src/components/CandidateTermsPanel.tsx`) to pass concepts.

`useRules.ts:135` and `TerminologyViolationsInbox.tsx:44`: pass `project.termMatching` (both have a `project` in scope; verify with `grep -n "project" ` in each).

- [ ] **Step 5: Run the affected suites and typecheck**

Run: `pnpm test src/lib/terminology src/lib/check src/lib/richtext src/components/TerminologyTermDetail.test.tsx && pnpm tsc -b --noEmit && pnpm lint`
Expected: PASS, no type errors, lint clean.

- [ ] **Step 6: Commit**

```bash
git add -A src/lib src/hooks src/components
git commit -m "refactor(terminology): route every source-side match through the concept matcher

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Persist `match` on concepts (migration, projection, read, events)

**Files:**
- Create: `db/postgres/migrations/0091_concepts_match_options.sql`
- Modify: `db/postgres/schema.sql:748-760` (add column to the canonical schema)
- Modify: `sync-worker/src/events/types.ts:615-634` (payloads gain `match?: TermMatchOptionsPayload`)
- Modify: `sync-worker/src/events/event-projection.ts:1616-1670`
- Modify: `sync-worker/src/events/concepts-read-route.ts` (raw row `match_options`, out `matchOptions`)
- Modify: `src/lib/sync/outbox-types.ts:445-462`, `src/lib/sync/events-emit.ts:1495-1565`, `src/lib/sync/concepts-read.ts:33,60`
- Test: `sync-worker/src/__tests__/term-projection.test.ts`

**Interfaces:**
- Produces: `TermCreateInput.match?`, `TermUpdateInput.match?`; wire field `matchOptions: TermMatchOptions | null`.

- [ ] **Step 1: Migration**

`db/postgres/migrations/0091_concepts_match_options.sql`:

```sql
-- AQU-1271: per-concept source-term matching options (mark folding, affix
-- tolerance, extra forms, excluded forms). Nullable JSON; NULL means "all
-- defaults", which is what every pre-existing concept gets. Read by the
-- concepts read route; written by term.create / term.update projection.

ALTER TABLE concepts ADD COLUMN IF NOT EXISTS match_options JSONB;
```

Add `match_options JSONB,` after `case_sensitive` in `db/postgres/schema.sql`'s `CREATE TABLE concepts`.

- [ ] **Step 2: Write the failing projection tests**

Append to `sync-worker/src/__tests__/term-projection.test.ts`:

```ts
  it('term.create stores match options as JSON; absent writes NULL', () => {
    // WHY: the option object must survive the round trip verbatim; a concept
    // without options must project NULL so the read route resolves defaults.
    const withOpts = project('term.create', {
      conceptId: 'c1', sourceTerm: 'הארץ', renderings: [], status: 'draft',
      match: { foldMarks: true, excludedForms: ['בארץ'] },
    })
    expect(withOpts.recorded[0].sql).toContain('match_options')
    expect(withOpts.recorded[0].args).toContain(JSON.stringify({ foldMarks: true, excludedForms: ['בארץ'] }))
    const without = project('term.create', { conceptId: 'c2', sourceTerm: 'x', renderings: [], status: 'draft' })
    expect(without.recorded[0].args).toContain(null)
  })

  it('term.update replaces match wholesale when present and leaves it alone when absent', () => {
    // WHY: like renderings, an options object has no per-key identity worth
    // merging; but an absent key must be COALESCEd so a notes-only edit from
    // another user never wipes someone's exclusions.
    const present = project('term.update', { conceptId: 'c1', match: { affixes: false } })
    expect(present.recorded[0].sql).toMatch(/match_options\s*=\s*COALESCE\(/)
    expect(present.recorded[0].args).toContain(JSON.stringify({ affixes: false }))
    const absent = project('term.update', { conceptId: 'c1', notes: 'hi' })
    const idx = absent.recorded[0].sql.split('COALESCE').findIndex((s) => s.includes('match_options'))
    expect(idx).toBeGreaterThan(-1)
    expect(absent.recorded[0].args.filter((a) => a === null).length).toBeGreaterThanOrEqual(1)
  })
```

- [ ] **Step 3: Run to verify failure**

Run: `cd sync-worker && npm test -- term-projection`
Expected: FAIL (no `match_options` in SQL).

- [ ] **Step 4: Server types and projection**

`sync-worker/src/events/types.ts`: add near `TermRenderingPayload`:

```ts
export interface TermMatchOptionsPayload {
  foldMarks?: boolean
  affixes?: boolean
  forms?: string[]
  excludedForms?: string[]
}
```

Add `match?: TermMatchOptionsPayload` to both `'term.create'` and `'term.update'` payloads.

`event-projection.ts` `term.create`: add `match_options` to the column list, `?::text::jsonb` to VALUES, and `p.match === undefined ? null : JSON.stringify(p.match)` to bind (after `case_sensitive`'s bind). `term.update`: add `match_options = COALESCE(?::text::jsonb, match_options),` after `case_sensitive`, bind `p.match === undefined ? null : JSON.stringify(p.match)` in the matching position.

`concepts-read-route.ts`: add `match_options: unknown` to `ConceptRowRaw`, `matchOptions: TermMatchOptionsOut | null` to `ConceptRowOut` (define `TermMatchOptionsOut` mirroring the payload type), and a `parseMatchOptions(raw: unknown)` that JSON-parses strings, accepts only plain objects, keeps the four known keys with type checks (booleans, string arrays), returns `null` otherwise. Add the column to the SELECT.

- [ ] **Step 5: Client types and emitters**

`outbox-types.ts`: add `match?: TermMatchOptions` to `"term.create"` and `"term.update"` (import type from `@/lib/terminology/types`).

`events-emit.ts`: `TermCreateInput.match?: TermMatchOptions`, payload `...(input.match ? { match: input.match } : {})`; `TermUpdateInput.match?: TermMatchOptions`, payload `...(input.match !== undefined ? { match: input.match } : {})`.

`concepts-read.ts`: `ConceptRowWire.matchOptions: TermMatchOptions | null`; in `toConcept`: `...(row.matchOptions ? { match: row.matchOptions } : {})`.

- [ ] **Step 6: Run tests and typecheck both packages**

Run: `cd sync-worker && npm test -- term-projection && npx tsc --noEmit -p . ; cd .. && pnpm tsc -b --noEmit`
Expected: PASS.

- [ ] **Step 7: Apply the migration locally**

Run: `pnpm neon:migrate:status` then the apply script the `neon:*` family provides for the local dev DB (read `package.json` scripts; the dev-stack shared PG is `aquilla-dev-pg`). Confirm `\d concepts` shows `match_options`. Do NOT apply to production; note in the PR that prod needs the migration.

- [ ] **Step 8: Commit**

```bash
git add db sync-worker/src src/lib/sync
git commit -m "feat(terminology): persist concept match options through term.* events

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: TBX round-trip

**Files:**
- Modify: `src/lib/terminology/tbx.ts:86-100,130-170`
- Test: `src/lib/terminology/tbx.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { exportConceptsTbx, importConceptsTbx } from "./tbx"
import type { Concept } from "./types"

const concept: Concept = {
  id: "c1",
  sourceTerm: "הָאָ֗רֶץ",
  renderings: [{ rendering: "earth", status: "preferred" }],
  status: "active",
  createdAt: "2026-09-14T00:00:00.000Z",
  match: { foldMarks: true, affixes: false, forms: ["אֶרֶץ"], excludedForms: ["בארץ"] },
}

describe("TBX match options", () => {
  // WHY: a termbase exported and re-imported must not silently lose the
  // matching rules users tuned; forms are standard TBX variants, options are
  // an Aquilla-specific note.
  it("round-trips forms as variant tigs and options as a termNote", () => {
    const xml = exportConceptsTbx([concept])
    expect(xml).toContain('<termNote type="termType">variant</termNote>')
    expect(xml).toContain('<termNote type="aquillaMatchOptions">')
    const [back] = importConceptsTbx(xml)
    expect(back.sourceTerm).toBe("הָאָ֗רֶץ")
    expect(back.match).toEqual(concept.match)
  })

  // WHY: files from other tools have no such note; import must not choke.
  it("imports legacy files without options unchanged", () => {
    const [back] = importConceptsTbx(exportConceptsTbx([{ ...concept, match: undefined }]))
    expect(back.match).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/lib/terminology/tbx.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement export**

In `termEntry`, replace the `sourceLang` construction:

```ts
  const { forms = [], ...optionsOnly } = c.match ?? {}
  const optionNote =
    Object.keys(optionsOnly).length > 0
      ? `\n          <termNote type="aquillaMatchOptions">${xmlEscape(JSON.stringify(optionsOnly))}</termNote>`
      : ""
  const headTig = `        <tig>\n          <term>${xmlEscape(c.sourceTerm)}</term>${optionNote}\n        </tig>`
  const variantTigs = forms
    .map((f) => `        <tig>\n          <term>${xmlEscape(f)}</term>\n          <termNote type="termType">variant</termNote>\n        </tig>`)
    .join("\n")
  const sourceLang = `\n      <langSet xml:lang="source">\n${[headTig, variantTigs].filter(Boolean).join("\n")}\n      </langSet>`
```

- [ ] **Step 4: Implement import**

Where tigs are collected (around line 140), also capture `termType` and `aquillaMatchOptions` termNotes per tig:

```ts
        const typeMatch = tigBlock.match(/<termNote[^>]*type="termType"[^>]*>([\s\S]*?)<\/termNote>/)
        const optMatch = tigBlock.match(/<termNote[^>]*type="aquillaMatchOptions"[^>]*>([\s\S]*?)<\/termNote>/)
        tigs.push({ term, status, termType: typeMatch?.[1].trim(), matchOptionsJson: optMatch ? xmlUnescape(optMatch[1].trim()) : undefined })
```

After `const sourceTerm = langSets[0].tigs[0]?.term`:

```ts
    const head = langSets[0].tigs[0]
    const forms = langSets[0].tigs.slice(1).filter((t) => t.termType === "variant").map((t) => t.term)
    let match: TermMatchOptions | undefined
    if (head?.matchOptionsJson) {
      try {
        const parsed: unknown = JSON.parse(head.matchOptionsJson)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) match = { ...(parsed as TermMatchOptions) }
      } catch {
        // Lenient import: a malformed note is ignored.
      }
    }
    if (forms.length > 0) match = { ...(match ?? {}), forms }
```

Include `...(match ? { match } : {})` in the pushed concept. Import `TermMatchOptions` type.

- [ ] **Step 5: Run tests**

Run: `pnpm test src/lib/terminology/tbx.test.ts src/lib/terminology`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/terminology/tbx.ts src/lib/terminology/tbx.test.ts
git commit -m "feat(terminology): TBX round-trip for forms and match options

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Shared UI piece: `MatchOptionsFields` + `DiscoveredFormsChips`

**Files:**
- Create: `src/components/terminology/MatchOptionsFields.tsx`
- Create: `src/components/terminology/DiscoveredFormsChips.tsx`
- Modify: `src/lib/i18n/namespaces/terminology.ts` (strings + metadata)
- Test: `src/components/terminology/DiscoveredFormsChips.test.tsx`

**Interfaces:**
- Produces:
  - `<MatchOptionsFields value: TermMatchOptions; resolved: ResolvedMatchOptions; showFoldMarks: boolean; hasAffixInventory: boolean; caseSensitive: boolean; disabled?: boolean; onChange(next: TermMatchOptions): void; onCaseSensitiveChange(v: boolean): void; onSetUpAffixes?: () => void />`
  - `<DiscoveredFormsChips forms: DiscoveredForm[]; disabled?: boolean; limit?: number; onToggleExclude(surface: string, excluded: boolean): void />`

- [ ] **Step 1: i18n keys**

Add to the strings object in `terminology.ts` (AddConceptDialog section) and matching metadata entries with descriptions:

```ts
    "terminology.match.wildcardHint": "Use * for endings that change, e.g. grac*",
    "terminology.match.previewCount": plural({ one: "Matches {count} place in this file", other: "Matches {count} places in this file" }, "count"),
    "terminology.match.previewCountProject": plural({ one: "Matches {count} place in this project", other: "Matches {count} places in this project" }, "count"),
    "terminology.match.formsLabel": "Forms",
    "terminology.match.formsEmpty": "No matches yet",
    "terminology.match.moreForms": "+{count} more",
    "terminology.match.excludeForm": "Exclude {form}",
    "terminology.match.includeForm": "Include {form}",
    "terminology.match.optionsLabel": "Matching options",
    "terminology.match.foldMarks": "Ignore vowel marks and accents",
    "terminology.match.affixes": "Allow prefixes and suffixes",
    "terminology.match.caseSensitive": "Match case exactly",
    "terminology.match.setUpAffixes": "Set up prefixes and suffixes for this project",
    "terminology.match.addFormLabel": "Add form",
    "terminology.match.addFormPlaceholder": "Another spelling of this term…",
```

Check `plural`'s exact signature in `src/lib/i18n/namespaces/types.ts` and match the existing `terminology.common.occurrenceCount` usage.

- [ ] **Step 2: Write the chips test**

```tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { DiscoveredFormsChips } from "./DiscoveredFormsChips"
import { I18nProvider } from "@/lib/i18n/I18nProvider"

const forms = [
  { surface: "וְהָאָ֗רֶץ", count: 3, excluded: false, sampleCellIds: [] },
  { surface: "הָאָֽרֶץ", count: 1, excluded: true, sampleCellIds: [] },
]

describe("DiscoveredFormsChips", () => {
  // WHY: the chip is the only affordance for exclusion; clicking must report
  // the surface and the NEW excluded state, and excluded chips must be
  // visibly distinct so users can tell what is off.
  it("renders counts and toggles exclusion", () => {
    const onToggle = vi.fn()
    render(<I18nProvider><DiscoveredFormsChips forms={forms} onToggleExclude={onToggle} /></I18nProvider>)
    fireEvent.click(screen.getByRole("button", { name: /Exclude וְהָאָ֗רֶץ/ }))
    expect(onToggle).toHaveBeenCalledWith("וְהָאָ֗רֶץ", true)
    fireEvent.click(screen.getByRole("button", { name: /Include הָאָֽרֶץ/ }))
    expect(onToggle).toHaveBeenCalledWith("הָאָֽרֶץ", false)
    expect(screen.getByText("3")).toBeTruthy()
  })
})
```

Check how other component tests wrap i18n (`grep -rn "I18nProvider" src/components/AddConceptDialog.test.tsx`) and copy that wrapper.

- [ ] **Step 3: Implement the chips**

```tsx
import { useState } from "react"
import { X, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { DiscoveredForm } from "@/lib/terminology/discover-forms"
import { cn } from "@/lib/utils"

interface Props {
  forms: DiscoveredForm[]
  disabled?: boolean
  limit?: number
  onToggleExclude: (surface: string, excluded: boolean) => void
}

export function DiscoveredFormsChips({ forms, disabled, limit = 6, onToggleExclude }: Props) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  if (forms.length === 0) return <p className="text-xs text-muted-foreground">{t("terminology.match.formsEmpty")}</p>
  const shown = expanded ? forms : forms.slice(0, limit)
  const hidden = forms.length - shown.length
  return (
    <div className="flex flex-wrap gap-1" data-testid="discovered-forms">
      {shown.map((f) => (
        <button
          key={f.surface}
          type="button"
          disabled={disabled}
          aria-pressed={!f.excluded}
          aria-label={f.excluded ? t("terminology.match.includeForm", { form: f.surface }) : t("terminology.match.excludeForm", { form: f.surface })}
          onClick={() => onToggleExclude(f.surface, !f.excluded)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
            f.excluded ? "border-dashed text-muted-foreground line-through" : "bg-muted",
          )}
        >
          <span dir="auto">{f.surface}</span>
          <span className="tabular-nums text-muted-foreground">{f.count}</span>
          {f.excluded ? <Plus className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
        </button>
      ))}
      {hidden > 0 && (
        <Button type="button" size="xs" variant="ghost" onClick={() => setExpanded(true)}>
          {t("terminology.match.moreForms", { count: hidden })}
        </Button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Implement the options fields**

```tsx
import { Checkbox } from "@/components/ui/checkbox"
import { FieldLabel } from "@/components/ui/field"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { TermMatchOptions } from "@/lib/terminology/types"
import type { ResolvedMatchOptions } from "@/lib/terminology/match-options"

interface Props {
  value: TermMatchOptions
  resolved: ResolvedMatchOptions
  showFoldMarks: boolean
  hasAffixInventory: boolean
  caseSensitive: boolean
  disabled?: boolean
  idPrefix: string
  onChange: (next: TermMatchOptions) => void
  onCaseSensitiveChange: (v: boolean) => void
  onSetUpAffixes?: () => void
}

export function MatchOptionsFields(p: Props) {
  const t = useT()
  const row = (id: string, label: string, checked: boolean, onChecked: (v: boolean) => void) => (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} disabled={p.disabled} onCheckedChange={(c) => onChecked(c === true)} />
      <FieldLabel htmlFor={id} className="text-xs font-normal">{label}</FieldLabel>
    </div>
  )
  return (
    <div className="grid gap-2" data-testid="match-options">
      {p.showFoldMarks &&
        row(`${p.idPrefix}-fold`, t("terminology.match.foldMarks"), p.resolved.foldMarks, (v) => p.onChange({ ...p.value, foldMarks: v }))}
      {p.hasAffixInventory
        ? row(`${p.idPrefix}-affix`, t("terminology.match.affixes"), p.resolved.affixes, (v) => p.onChange({ ...p.value, affixes: v }))
        : p.onSetUpAffixes && (
            <Button type="button" variant="link" size="xs" className="justify-start px-0" onClick={p.onSetUpAffixes}>
              {t("terminology.match.setUpAffixes")}
            </Button>
          )}
      {row(`${p.idPrefix}-case`, t("terminology.match.caseSensitive"), p.caseSensitive, p.onCaseSensitiveChange)}
    </div>
  )
}
```

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm test src/components/terminology && pnpm tsc -b --noEmit && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/terminology src/lib/i18n/namespaces/terminology.ts
git commit -m "feat(terminology): MatchOptionsFields and DiscoveredFormsChips

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Add-to-terminology popover: live preview, chips, options

**Files:**
- Modify: `src/components/AddConceptDialog.tsx`
- Modify: `src/components/SourceSelectionToolbar.tsx:89-100` (new props `cells`, `termMatching`, `onSetUpAffixes`)
- Modify: `src/components/EditorTable.tsx:6095-6104` (pass the file's cells as `{id, original}[]`, `project.termMatching`, and a navigate-to-settings callback)
- Modify: `src/components/ProjectWorkspace.tsx:5040-5065` (pass `...(draft.match ? { match: draft.match } : {})` to `emitTermCreate`)
- Test: `src/components/AddConceptDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `AddConceptDialog.test.tsx` (follow the file's existing render helper):

```tsx
  // WHY: the preview count and chips are how a user learns what the matcher
  // will do BEFORE saving; an option toggle must re-count live, and a chip
  // click must land in the submitted draft as an exclusion.
  it("previews matches, toggles options live, and submits exclusions", async () => {
    const onConfirm = vi.fn()
    const cells = [
      { id: "a", original: "וְהָאָ֗רֶץ הָיְתָה" },
      { id: "b", original: "אֵת הָאָֽרֶץ׃" },
      { id: "c", original: "nothing here" },
    ]
    renderPopover({ sourceTerm: "הָאָ֗רֶץ", cells, termMatching: { prefixes: ["ו"], suffixes: [] }, canApprove: true, onConfirm })
    await user.click(screen.getByRole("button", { name: /add to terminology/i }))
    expect(await screen.findByText(/Matches 2 places/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /Exclude וְהָאָ֗רֶץ/ }))
    expect(await screen.findByText(/Matches 1 place\b/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /^add$/i }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      sourceTerm: "הָאָ֗רֶץ",
      match: expect.objectContaining({ excludedForms: ["וְהָאָ֗רֶץ"] }),
    }))
  })
```

Adjust the trigger/submit button names to what the existing tests use.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/components/AddConceptDialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`AddConceptPopover` props gain:

```ts
  /** Cells to preview against (the open file). Absent = no preview line. */
  cells?: ReadonlyArray<{ id: string; original: string }>
  termMatching?: TermMatchingSettings
  onSetUpAffixes?: () => void
```

Form default values gain `match: {} as TermMatchOptions`. Add a derived block inside the component (after `form`):

```tsx
  const term = form.state.values.term  // subscribe via form.Subscribe or useStore per the file's TanStack version
  const match = form.state.values.match
  const caseSensitive = !form.state.values.caseInsensitive
  const previewConcept = useMemo(() => ({ sourceTerm: term, match, caseSensitive }), [term, match, caseSensitive])
  const resolved = useMemo(() => resolveMatchOptions(previewConcept, termMatching), [previewConcept, termMatching])
  const forms = useMemo(() => (cells ? discoverForms(cells, previewConcept, termMatching) : []), [cells, previewConcept, termMatching])
  const count = useMemo(() => (cells ? countConceptOccurrences(cells, previewConcept, termMatching) : 0), [cells, previewConcept, termMatching])
  const showFoldMarks = hasCombiningMarks(term) || (cells?.some((c) => hasCombiningMarks(c.original)) ?? false)
```

Use `form.Subscribe` (or the `useStore(form.store, …)` helper TanStack Form 1.x exposes) so these recompute on keystrokes; check how `AddConceptDialog.tsx` currently reads live values and match it.

Render, under the term field: `<p className="text-[11px] text-muted-foreground">{t("terminology.match.wildcardHint")}</p>`; when `cells` is present: the count line (`terminology.match.previewCount`), then `<DiscoveredFormsChips forms={forms} onToggleExclude={toggleExclude} />`; then a `<details>` / collapsible titled `terminology.match.optionsLabel` containing `<MatchOptionsFields … />` and remove the old standalone case-insensitive checkbox (its state moves into `MatchOptionsFields` via `onCaseSensitiveChange={(v) => form.setFieldValue("caseInsensitive", !v)}`).

`toggleExclude`:

```ts
  const toggleExclude = (surface: string, excluded: boolean) => {
    const current = form.getFieldValue("match").excludedForms ?? []
    const next = excluded ? [...new Set([...current, surface])] : current.filter((f) => f !== surface)
    form.setFieldValue("match", { ...form.getFieldValue("match"), ...(next.length ? { excludedForms: next } : { excludedForms: undefined }) })
  }
```

On submit, include `...(hasAnyOption(value.match) ? { match: pruneMatch(value.match) } : {})` where `pruneMatch` drops undefined keys and empty arrays; put `pruneMatch` in `src/lib/terminology/match-options.ts` and export it.

`SourceSelectionToolbar`: accept and forward `cells`, `termMatching`, `onSetUpAffixes`.

`EditorTable.tsx`: near line 6095 pass `cells={fileCellsForPreview}` where `fileCellsForPreview = useMemo(() => cells.map(c => ({ id: c.id, original: c.original })), [cells])` (find the file's cell array name in scope; it is the array rendered by the table), `termMatching={project.termMatching}`, `onSetUpAffixes={() => navigate(\`/project/${project.id}/settings#section-terminology\`)}` using whatever navigation helper EditorTable already uses (`grep -n "useNavigate\|requestNavigate" src/components/EditorTable.tsx`).

`ProjectWorkspace.tsx` add-concept handler: `...(draft.match ? { match: draft.match } : {})` in the `emitTermCreate` call.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm test src/components/AddConceptDialog.test.tsx src/components/SelectionTermActions.race.test.tsx && pnpm tsc -b --noEmit && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/AddConceptDialog.tsx src/components/AddConceptDialog.test.tsx src/components/SourceSelectionToolbar.tsx src/components/EditorTable.tsx src/components/ProjectWorkspace.tsx src/lib/terminology/match-options.ts
git commit -m "feat(terminology): live match preview, discovered-form chips and options in the add popover

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Term detail page: Forms section and Matching row

**Files:**
- Modify: `src/components/TerminologyTermDetail.tsx` (new props `termMatching?`, `onMatchChange?: (conceptId: string, match: TermMatchOptions | undefined) => void | Promise<void>`, `onCaseSensitiveChange?`, `onSetUpAffixes?`)
- Modify: `src/components/TerminologyPage.tsx:1156-1171,1243` (add `handleMatchChange` mirroring `handleRenderingsChange`, emitting `emitTermUpdate({ …, match })`; pass the new props)
- Test: `src/components/TerminologyTermDetail.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
  // WHY: excluding a form from the term page must persist through term.update
  // with the FULL match object (the projection replaces it wholesale), and the
  // occurrence count must drop immediately.
  it("Forms section lists surface forms and excluding one emits the full match object", async () => {
    const onMatchChange = vi.fn()
    const concept = makeConcept({ sourceTerm: "הָאָ֗רֶץ", match: { foldMarks: true } })
    const cells = [
      makeCell({ id: "a", original: "וְהָאָ֗רֶץ הָיְתָה" }),
      makeCell({ id: "b", original: "אֵת הָאָֽרֶץ׃" }),
    ]
    renderDetail({ concept, cells, termMatching: { prefixes: ["ו"], suffixes: [] }, canManageTermbase: true, onMatchChange })
    expect(screen.getByText("2")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /Exclude וְהָאָ֗רֶץ/ }))
    expect(onMatchChange).toHaveBeenCalledWith(concept.id, { foldMarks: true, excludedForms: ["וְהָאָ֗רֶץ"] })
  })

  // WHY: manual variants are the escape hatch; adding one must go through the
  // same term.update path.
  it("Add form appends to match.forms", async () => {
    const onMatchChange = vi.fn()
    const concept = makeConcept({ sourceTerm: "אֶרֶץ" })
    renderDetail({ concept, cells: [], canManageTermbase: true, onMatchChange })
    await user.type(screen.getByPlaceholderText(/Another spelling/), "אָרֶץ{enter}")
    expect(onMatchChange).toHaveBeenCalledWith(concept.id, { forms: ["אָרֶץ"] })
  })
```

Use the file's existing `makeConcept` / `renderDetail` helpers (create them if the test file has none, following its current render pattern).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/components/TerminologyTermDetail.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `TerminologyTermDetail.tsx` after the stats summary block (line ~530), add:

```tsx
        {/* AQU-1271: Forms + matching options */}
        <section className="grid gap-2" data-testid="term-forms">
          <h3 className="text-xs font-medium">{t("terminology.match.formsLabel")}</h3>
          <DiscoveredFormsChips
            forms={discovered}
            disabled={!canEditMatch}
            onToggleExclude={(surface, excluded) => {
              const current = concept.match?.excludedForms ?? []
              const excludedForms = excluded ? [...new Set([...current, surface])] : current.filter((f) => f !== surface)
              void onMatchChange?.(concept.id, pruneMatch({ ...concept.match, excludedForms }))
            }}
          />
          {canEditMatch && (
            <Input
              placeholder={t("terminology.match.addFormPlaceholder")}
              aria-label={t("terminology.match.addFormLabel")}
              className="h-7 text-xs"
              onKeyDown={(e) => {
                if (e.key !== "Enter") return
                e.preventDefault()
                const v = e.currentTarget.value.trim()
                if (!v) return
                void onMatchChange?.(concept.id, pruneMatch({ ...concept.match, forms: [...new Set([...(concept.match?.forms ?? []), v])] }))
                e.currentTarget.value = ""
              }}
            />
          )}
          <MatchOptionsFields
            idPrefix={`term-${concept.id}`}
            value={concept.match ?? {}}
            resolved={resolved}
            showFoldMarks={hasCombiningMarks(concept.sourceTerm) || discovered.some((f) => hasCombiningMarks(f.surface))}
            hasAffixInventory={resolved.prefixes.length + resolved.suffixes.length > 0}
            caseSensitive={concept.caseSensitive === true}
            disabled={!canEditMatch}
            onChange={(next) => void onMatchChange?.(concept.id, pruneMatch(next))}
            onCaseSensitiveChange={(v) => void onCaseSensitiveChange?.(concept.id, v)}
            onSetUpAffixes={onSetUpAffixes}
          />
        </section>
```

with `const discovered = useMemo(() => discoverForms(cells, concept, termMatching), [cells, concept, termMatching])`, `const resolved = useMemo(() => resolveMatchOptions(concept, termMatching), [concept, termMatching])`, `const canEditMatch = canManageTermbase && Boolean(onMatchChange)`. `pruneMatch` returns `undefined` when nothing is set; `onMatchChange` receives `TermMatchOptions | undefined` and the page sends `match: next ?? {}` (an empty object clears all options; the projection replaces wholesale).

`TerminologyPage.tsx`:

```ts
  const handleMatchChange = useCallback(
    async (conceptId: string, match: TermMatchOptions | undefined) => {
      if (!project) return
      try {
        await emitTermUpdate({ projectId: project.id, conceptId, match: match ?? {}, author })
        await afterWrite()
        setDrillDownConcept((prev) => (prev && prev.id === conceptId ? { ...prev, match } : prev))
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update matching options")
      }
    },
    [project, author, afterWrite],
  )
  const handleCaseSensitiveChange = useCallback(
    async (conceptId: string, caseSensitive: boolean) => {
      if (!project) return
      await emitTermUpdate({ projectId: project.id, conceptId, caseSensitive, author })
      await afterWrite()
      setDrillDownConcept((prev) => (prev && prev.id === conceptId ? { ...prev, caseSensitive } : prev))
    },
    [project, author, afterWrite],
  )
```

Pass `termMatching={project?.termMatching}`, `onMatchChange={handleMatchChange}`, `onCaseSensitiveChange={handleCaseSensitiveChange}`, `onSetUpAffixes={() => navigate(\`/project/${id}/settings#section-terminology\`)}` at line 1243.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm test src/components/TerminologyTermDetail.test.tsx src/components/GlossaryEditor.test.tsx && pnpm tsc -b --noEmit && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminologyTermDetail.tsx src/components/TerminologyTermDetail.test.tsx src/components/TerminologyPage.tsx
git commit -m "feat(terminology): Forms section and matching options on the term page

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Project settings: affix inventory editor

**Files:**
- Create: `src/components/ProjectSettings/TermMatchingSection.tsx`
- Modify: `src/components/ProjectSettings.tsx` (Baseline `termMatching`, state, diff, `sharedUpdates.termMatching`, mount inside `#section-terminology` below the existing row)
- Modify: `src/lib/i18n/namespaces/projectSettings.ts`
- Test: `src/components/ProjectSettings/TermMatchingSection.test.tsx`

- [ ] **Step 1: i18n keys** (strings + metadata):

```ts
    "projectSettings.termMatching.title": "Prefixes and suffixes",
    "projectSettings.termMatching.description": "Letters or syllables that attach to source words. Terminology matching will allow them around a term when the term's \"Allow prefixes and suffixes\" option is on.",
    "projectSettings.termMatching.prefixes": "Prefixes",
    "projectSettings.termMatching.suffixes": "Suffixes",
    "projectSettings.termMatching.maxAffixes": "Max chained per side",
    "projectSettings.termMatching.foldMarksDefault": "Ignore vowel marks and accents by default",
    "projectSettings.termMatching.loadPreset": "Load preset",
    "projectSettings.termMatching.addAffixPlaceholder": "Type and press Enter",
    "projectSettings.termMatching.remove": "Remove {affix}",
```

- [ ] **Step 2: Write the failing test**

```tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TermMatchingSection } from "./TermMatchingSection"

describe("TermMatchingSection", () => {
  // WHY: the inventory is plain data the admin owns. Adding, removing, and
  // preset-loading must all flow through onChange with the whole object so
  // the settings form can diff it against the baseline.
  it("adds and removes affixes and loads a preset", () => {
    const onChange = vi.fn()
    render(<TermMatchingSection value={{ prefixes: [], suffixes: [] }} onChange={onChange} disabled={false} />)
    const prefixInput = screen.getByRole("textbox", { name: "Prefixes" })
    fireEvent.change(prefixInput, { target: { value: "ו" } })
    fireEvent.keyDown(prefixInput, { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith({ prefixes: ["ו"], suffixes: [] })
    fireEvent.click(screen.getByRole("button", { name: "Load preset" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Hebrew" }))
    expect(onChange.mock.calls.at(-1)?.[0].prefixes).toContain("ל")
  })
})
```

Wrap in the i18n provider the other `ProjectSettings/*.test.tsx` files use.

- [ ] **Step 3: Implement the section**

Props: `{ value: TermMatchingSettings; onChange(next: TermMatchingSettings): void; disabled: boolean }`. Two tag-input rows (a controlled `Input` with Enter-to-add and a chip list with remove buttons, aria-label `projectSettings.termMatching.remove`), a number input for `maxAffixes` (1..4), a `Switch` for `foldMarksDefault`, and a `DropdownMenu` (from `@/components/ui/dropdown-menu`) listing `AFFIX_PRESETS` with `t(preset.labelKey)`; selecting one calls `onChange({ ...value, prefixes: preset.prefixes, suffixes: preset.suffixes })`. Use `SettingsRow` / `SettingsGroup` from the same folder for layout (see how `ValidationSettingsSection` composes them).

- [ ] **Step 4: Wire into ProjectSettings.tsx**

Baseline: `termMatching: TermMatchingSettings` with `buildBaseline` returning `project.termMatching ?? { prefixes: [], suffixes: [] }`. State: `const [termMatching, setTermMatching] = useState<TermMatchingSettings>({ prefixes: [], suffixes: [] })`, reset from baseline where the others reset (line ~531). Dirty check (line ~667): `JSON.stringify(termMatching) !== JSON.stringify(baseline.termMatching)`. Save (line ~893): `if (JSON.stringify(termMatching) !== JSON.stringify(baseline.termMatching)) { sharedUpdates.termMatching = termMatching; changedFieldLabels.push("term matching affixes") }`. New baseline (line ~975): `termMatching`. Mount `<TermMatchingSection value={termMatching} onChange={setTermMatching} disabled={!canEdit} />` inside the `#section-terminology` `SettingsGroup` after the existing `SettingsRow`, using whatever the file's edit-permission boolean is named.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm test src/components/ProjectSettings && pnpm tsc -b --noEmit && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/ProjectSettings src/components/ProjectSettings.tsx src/lib/i18n/namespaces/projectSettings.ts
git commit -m "feat(settings): terminology affix inventory with presets

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: E2E journey and verification

**Files:**
- Create: `e2e/specs/terminology/pointed-term-forms.spec.ts`
- Modify: `e2e/helpers/page-objects/Glossary.ts` (add `openDetails` already exists; add `formsChips()` locator and `excludeForm(surface)`)
- Modify: `e2e/JOURNEYS.md` (add the journey line per AGENTS.md)

- [ ] **Step 1: Seed data**

Check `e2e/helpers/seed-project.ts` for how `seedProjectWithFile` picks its fixture; add a fixture `e2e/fixtures/genesis-1-pointed.md` containing three lines: `בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָֽרֶץ׃`, `וְהָאָ֗רֶץ הָיְתָה תֹ֙הוּ֙ וָבֹ֔הוּ`, `וַיִּקְרָ֨א אֱלֹהִ֤ים ׀ לַיַּבָּשָׁה֙ אֶ֔רֶץ`, and let the seed helper accept a fixture name option if it does not already.

- [ ] **Step 2: Spec**

```ts
import { test, expect } from "../../helpers/multi-user"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * AQU-1271: a pointed Hebrew term matches across accents and, once the
 * project has a prefix inventory, across prefixes; excluding a discovered form
 * drops it from the occurrence count.
 */
test("pointed term matches variant pointing and prefixes; exclusion sticks", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Forms ${Date.now()}`, fixture: "genesis-1-pointed.md" })
  await openSeededProject(alice, seeded)

  // Project affix inventory.
  await alice.goto(`/project/${seeded.projectId}/settings#section-terminology`)
  await alice.getByRole("button", { name: "Load preset" }).click()
  await alice.getByRole("menuitem", { name: "Hebrew" }).click()
  await alice.getByRole("button", { name: /^save$/i }).click()

  const glossary = new Glossary(alice)
  await glossary.goto(seeded.projectId)
  await glossary.addTerm("הָאָ֗רֶץ", "earth")
  await glossary.openDetails("הָאָ֗רֶץ")

  // Two cells contain הארץ with or without prefix; the third has אֶרֶץ only.
  await expect(alice.getByTestId("term-forms")).toBeVisible()
  await expect(alice.getByText(/2 occurrences|Occurs in 2/)).toBeVisible()

  await alice.getByRole("button", { name: /Exclude וְהָאָ֗רֶץ/ }).click()
  await expect(alice.getByText(/1 occurrence\b|Occurs in 1/)).toBeVisible()
  await alice.reload()
  await glossary.openDetails("הָאָ֗רֶץ")
  await expect(alice.getByRole("button", { name: /Include וְהָאָ֗רֶץ/ })).toBeVisible()
})
```

Read the actual `terminology.common.occurrenceCount` English string and match the regex to it.

- [ ] **Step 3: Run the spec against the local stack**

Per `AGENTS.md` and memory (`e2e-single-stack-only`, `colima-dev-runtime`): `colima start` if needed, then `pnpm test:e2e -- e2e/specs/terminology/pointed-term-forms.spec.ts`. Expected: PASS. Then `pnpm test:e2e:smoke` for the terminology folder to confirm the existing wildcard chip spec still passes.

- [ ] **Step 4: Full unit suites**

Run: `pnpm test && (cd sync-worker && npm test) && pnpm lint && pnpm build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add e2e
git commit -m "test(e2e): pointed-term forms journey (AQU-1271)

Refs AQU-1271

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage:** data model (T1, T6), matcher folding/wildcard (T2), affixes/forms/exclusions/single-pattern (T3), discovered forms (T4), one-matcher consumers (T5), TBX (T7), popover UX (T8, T9), term page UX (T10), project settings (T11), tests incl. E2E (T12). Lemma keying, USFM attributes, equivalents tokenizer: out of scope per spec.
- **Placeholders:** none; where a repo detail must be looked up the step names the exact grep.
- **Type consistency:** `TermMatchOptions`, `TermMatchingSettings`, `ResolvedMatchOptions`, `resolveMatchOptions`, `hasCombiningMarks`, `pruneMatch` (T9 introduces, T10 uses), `conceptToRegexSource`, `buildConceptRegex`, `matchesConcept`, `findConceptMatches`, `discoverForms`, `countConceptOccurrences`, `findConceptMatchRanges` are named identically across tasks.
