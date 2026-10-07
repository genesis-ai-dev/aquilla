# Terminology: source-form matching (marks, affixes, wildcards, discovered forms)

**Date:** 2026-09-14
**Status:** draft for review
**Scope:** how a Concept's `sourceTerm` matches source text when the text is
inflected, agglutinated, or carries variable diacritics. Applies to every
source language; nothing here is Hebrew-specific in code.

## Problem

A user adds הָאָ֗רֶץ to terminology from Genesis 1:1 and expects it to match
וְהָאָ֗רֶץ (conjunction prefix), הָאָ֑רֶץ (different accent), and בָּאָ֣רֶץ
(preposition prefix). Today ([src/lib/terminology/match.ts](../../../src/lib/terminology/match.ts)):

- Terms match as runs of Unicode letters (`\p{L}`) with letter-based
  boundaries. Vowel points and accents are combining marks (`\p{M}`), so a
  term only matches occurrences carrying byte-identical pointing.
- The prefix case matches today only by accident (the sheva under ו is a mark,
  so the leading boundary does not see a letter). Stripping marks would break
  it, because ו would then abut ה. Mark folding and affix tolerance must ship
  together.
- The only inflection tool is the `*` wildcard, which users have to know about
  and which expands to letters only, so it stops at the first mark.

The same shape recurs outside Hebrew: Arabic harakat, Syriac, Bantu noun-class
prefixes, Turkish and Finnish suffix chains, Greek accents. The fix must be a
general mechanism the user can switch on per project and per term.

## Design principles

1. **Store what the user typed; fold only at match time.** No lossy rewrite of
   `sourceTerm`.
2. **Options, not language rules.** The code knows about "combining marks",
   "prefix strings", "suffix strings", and "wildcards". Language presets are
   data that pre-fill those options; a user can edit or ignore them.
3. **Show, don't explain.** The UI makes the matcher's behaviour visible
   through a live count and the list of surface forms it actually matched.
4. **One matcher.** Every consumer (rule compile, stats, editor chips,
   pre-acceptance, candidates, term detail, live check) calls the same
   concept-aware helper, as today.
5. **Offsets stay in the original text.** Editor decorations depend on match
   offsets, so folding is expressed inside the regex rather than by rewriting
   the haystack.

## Data model

### Concept (client `types.ts`, server `concepts` table)

```ts
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

export interface Concept {
  // …existing fields…
  match?: TermMatchOptions
}
```

- `caseSensitive` stays where it is; it is already wired end to end.
- Every field is optional. An absent `foldMarks` resolves to a **script-derived
  default**: true when `sourceTerm` (after NFD) contains any `\p{M}`, else
  false. An absent `affixes` resolves to true when the project has a non-empty
  affix inventory, else false. Defaults are computed by one pure function
  `resolveMatchOptions(concept, projectTermMatching)` so every consumer agrees.
- Server: migration adds `match_options JSONB` to `concepts` (nullable).
  `term.create` inserts it; `term.update` uses the same COALESCE-per-column
  pattern as the other fields (a present `match` replaces wholesale, like
  `renderings`). Read route and `concepts-read.ts` pass it through.
- Outbox payloads `term.create` / `term.update` gain `match?: TermMatchOptions`.
  Emitters in `events-emit.ts` follow.

### Project settings (`ProjectWideSettings`)

```ts
export interface TermMatchingSettings {
  prefixes: string[]      // e.g. ["ו","ה","ב","כ","ל","מ","ש"]
  suffixes: string[]      // e.g. ["ים","ות","י","ך","ו","ה","נו","כם","הם"]
  maxAffixes?: number     // chained affixes allowed per side, default 2
  foldMarksDefault?: boolean  // overrides the script-derived default
}
// ProjectWideSettings.termMatching?: TermMatchingSettings
```

Presets live in `src/lib/terminology/affix-presets.ts` as plain data keyed by
language code (Hebrew, Arabic, Swahili, Turkish to start). Loading a preset
copies its lists into the settings; nothing at match time reads presets.

### TBX round-trip

- `match.forms` export as additional `<tig>` entries in the source `langSet`
  with `<termNote type="termType">variant</termNote>`; import reads them back.
- `foldMarks`, `affixes`, `excludedForms` export as one
  `<termNote type="aquillaMatchOptions">` JSON note on the source tig; import
  is lenient and ignores it when absent or malformed.

## Matcher

`match.ts` gains an options parameter and a concept-level entry point.

```ts
export interface TermRegexOptions {
  foldMarks?: boolean
  prefixes?: string[]
  suffixes?: string[]
  maxAffixes?: number
}
export function termToRegexSource(term: string, opts?: TermRegexOptions): string | null
export function conceptToRegexSource(concept: Concept, project?: TermMatchingSettings): string | null
export function matchesConcept(haystack: string, concept: Concept, project?: TermMatchingSettings): boolean
export function findConceptMatches(haystack, concept, project): Array<{ start: number; end: number; surface: string }>
```

Regex construction, in order:

1. **Literal body.** Split on `*`, regex-escape each segment. When `foldMarks`,
   NFD the segment, drop `\p{M}`, and emit `\p{M}*` after every remaining
   character so pointed text still matches at its original offsets.
2. **Wildcard.** `*` expands to `[\p{L}\p{M}]*` (was `\p{L}*`). This is a
   strict widening: existing terms match everything they matched before, plus
   inflections that carry marks.
3. **Affixes.** When enabled and the inventory is non-empty:
   lead becomes `(?<!\p{L})(?:(?:p1|p2|…)\p{M}*){0,N}` and trail becomes
   `(?:\p{M}*(?:s1|s2|…)){0,N}(?!\p{L})`. Affix literals are escaped and, when
   `foldMarks`, folded the same way as the body. Longer affixes sort first in
   the alternation so `ים` wins over `י`.
4. **Forms.** `sourceTerm` and each of `match.forms` compile to their own
   pattern; the concept pattern is their alternation, each wrapped in its own
   boundaries and affix groups.
5. **Exclusions.** The concept pattern is prefixed with a negative lookahead
   `(?!(?:e1|e2|…)(?!\p{L}))` built from `excludedForms` (escaped, folded when
   `foldMarks`). This keeps exclusion inside a single regex so `compile.ts`
   can still hand the rule engine one `sourcePattern`.

`compile.ts` switches from `termToRegexSource(concept.sourceTerm)` to
`conceptToRegexSource(concept, project)`. The rule engine already compiles
`term:` rules with the `u` flag. Target renderings are unchanged in this
slice; they keep plain `termToRegexSource` with the widened wildcard.

Every current caller of `matchesTerm(text, concept.sourceTerm, …)` on a
**source** side migrates to `matchesConcept` / `findConceptMatches`. The
implementation plan enumerates them by grep; known ones are
`TerminologyTermDetail`, `stats.ts`, `candidates-worker.ts`,
`preacceptance.ts`, `glossary-view.ts`, `live-term-check.ts`, and
`terminology-chip-plugin.ts`.

## Discovered forms

```ts
export interface DiscoveredForm { surface: string; count: number; excluded: boolean; sampleCellIds: string[] }
export function discoverForms(cells: Array<{ id: string; original: string }>, concept: Concept, project?: TermMatchingSettings): DiscoveredForm[]
```

Runs `findConceptMatches` with exclusions **disabled** so excluded forms still
appear (flagged) and can be re-included. Groups by exact surface string, sorted
by count. Pure and synchronous; callers pass the cell set they already hold
(the term detail page's `cells`, the editor's loaded file cells). No new
persistence.

## UX

### Add-to-terminology popover (`AddConceptDialog.tsx`)

- Source-term input keeps focus. Helper text under it: "Use `*` for endings
  that change, e.g. `grac*`".
- Below: **live preview line** "Matches N places in this file", recomputed on
  every keystroke and option change from the loaded cells.
- Below that: **Forms chips**, the top six discovered surface forms with
  counts, "+k more" expands. Clicking a chip toggles exclusion (struck through,
  moves to `excludedForms`).
- **Matching options** disclosure, collapsed by default, showing only what
  applies:
  - "Ignore vowel marks and accents" checkbox. Shown when the term or the
    file's source text contains combining marks. Pre-checked per the resolved
    default.
  - "Allow prefixes and suffixes" checkbox. Shown when the project has an
    affix inventory; otherwise a one-line link "Set up prefixes and suffixes
    for this project" that opens project settings.
  - The existing case-sensitivity checkbox moves in here.
- Draft submission carries `match` alongside the existing fields.

### Term detail page (`TerminologyTermDetail.tsx`)

- New **Forms** section: the same chips with counts, each with an exclude
  toggle, plus an "Add form" input for manual variants (`match.forms`).
- **Matching** row under the source term: the two checkboxes above plus case
  sensitivity, editable when `canEdit`. Changes emit `term.update` with the
  full `match` object.
- Occurrence count and verdicts already come from the shared matcher, so they
  update as options change.

### Project settings, Terminology section

- **Prefixes** and **Suffixes** tag inputs; **Max chained** number input.
- "Load preset" menu listing the presets file; loading fills the inputs and
  the user may edit afterwards.
- "Ignore marks by default" switch.

## Testing

- `match.test.ts`: folding matches across differing accents; folding preserves
  match offsets in the original string; affix lead/trail with chaining limit;
  longest-affix-first ordering; wildcard now spans marks; exclusion lookahead;
  forms alternation; regex-escape safety on affixes and forms; script-derived
  defaults.
- `compile.test.ts`: concept with options produces the expected `sourcePattern`
  and the rule engine flags or clears the Genesis 1:1 cases.
- `discover-forms.test.ts`: grouping, counts, excluded flagging, sort order.
- `tbx.test.ts`: forms and options round-trip; legacy files import unchanged.
- `sync-worker`: projection test for `match_options` on create and update
  (present replaces, absent leaves alone); read route returns it.
- Component tests: popover preview count and chip exclusion; term detail
  Forms section emits `term.update`.
- E2E (per `AGENTS.md`): one glossary journey that adds a pointed term with
  affixes enabled and asserts the occurrence count on the term page.

## Out of scope, tracked separately

- **Lemma keying** over MACULA morph rows (match by lemma or Strong's when a
  source file has morphology). Follow-up spec; the `match` object is the
  natural home for a future `lemma` key.
- **USFM `\w` attribute retention.** [usfm.ts:92](../../../src/lib/parsers/usfm.ts:92)
  drops lemma and Strong's attributes on import.
- **Equivalents tokenizer bug.** `equivalents.ts` and the two alignment models
  tokenize on `[\p{L}\p{N}]+`, which splits pointed Hebrew into single
  consonants. Needs `\p{M}` in the class.
- Target-side affix tolerance for renderings.
