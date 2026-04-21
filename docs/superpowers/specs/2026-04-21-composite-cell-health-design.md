# Composite Cell Health

**Status:** Design
**Date:** 2026-04-21
**Scope:** Replace the current override-based cell-health calculation (validation → 100, rule penalties subtracted) with a composite score where every dimension contributes to every cell, every time. Introduce a dual-sided neighborhood signal derived from branching + plain search, a configurable cap system with project-level overrides, and a hover breakdown UI that surfaces *why* a cell scored what it did.

---

## Motivation

Today's health calculation in `src/lib/health/health-engine.ts` treats human validation as an override: any validated cell is pinned at 100, regardless of whether it breaks rules, drifts from surrounding cells, or was translated inconsistently with similar source text. Rule penalties are then subtracted — but they can only reach a validated cell, not unvalidate it. The result is a health pill that tells you whether a human touched the cell, not whether the translation is good.

Two failure modes follow:

1. **Validated-but-wrong cells score 100.** A user who checks "validated" on a cell with a capitalization error, inconsistent terminology, and a translation that disagrees with five similar cells elsewhere in the project sees a green ring. The metric doesn't distinguish "a human claimed this is correct" from "this is actually correct."
2. **Fresh-project cells score 0.** An unvalidated LLM cell whose `examples[]` array is empty — because the branching search returned nothing, because the active file has no translations yet — lands at 0 with no partial credit for weak-but-present signal. New projects look like disasters until a human manually validates a critical mass of cells.

Both are symptoms of the same modeling choice: health is a binary pipe (validated or not) with penalties grafted on. The fix is a composite score where validation, ancestry quality, neighborhood agreement, and rule conformance all contribute to every cell — with a hover breakdown that exposes the decomposition when a user wants to see why.

This spec also fixes a bug flagged during brainstorming: `useSearchIndex` today ignores its `project.files` argument and indexes only the currently-active file's cells, so few-shot search returns empty on fresh files and on cross-file queries. The unified `DualIndex` introduced here is built from the entire project corpus, not just one file.

## Goals

1. **One composite score per cell, zero to one hundred.** Every dimension contributes; no dimension is an override. Validation is a strong input, not a cap on truth.
2. **Deterministic across viewers.** The health number is identical regardless of which user is looking at a given project state. Self/others/full bucketing stays UI-only; the math uses validator counts.
3. **Four dimensions, each a capped subtraction from 100:** `Reviewed`, `Examples`, `Consistency`, `Rules`. Sum of caps bounded so that no single dimension can drive the score below zero alone.
4. **Dual-sided neighborhood signal.** Confidence that a translation "lives where its source lives" is derived from two searches — one by source, one by target — blended via configurable weights from TF-IDF token overlap and cell-ID weighted Jaccard.
5. **Coverage-weighted aggregation.** Wherever the scorer averages over multiple neighbors (ancestry examples, neighborhood overlap), the weight comes from how much of the query each neighbor actually covered, not a naive mean. A single high-coverage example dominates a dozen thin matches.
6. **Project-level configurability.** All caps, weights, and rule penalties live in a defaults file; projects override selectively. A per-project "follow defaults" toggle decides whether future default changes propagate; a "reset overrides" button rebaselines without changing the toggle.
7. **Hover breakdown UI.** Tooltip glance view shows the four signed contributions; click opens a popover with per-signal detail (which examples, which neighbors, which rules fired), neighbor/example cell IDs clickable to jump to the offending cell.
8. **Accurate aggregate health.** File- and project-level rings run the full scoring pipeline across all cells via a web worker, with incremental updates on cell edits. "Biggest drags on health" list surfaces the top-3 worst cells in file/project popovers.
9. **Ship behind `composite-health` experimental flag.** Follows the pattern landed by Living Memory; flipped on for dogfood projects first, then default-on once signals are validated.

## Non-Goals

- **Semantic similarity via embeddings.** The neighborhood signal is strictly token-level and ID-set-level — deterministic, cheap, language-agnostic, no model calls. Embedding-based similarity is a possible future dimension, not v1.
- **Backtranslation as a health signal.** Backtranslation exists in the codebase but is a manual, LLM-generated check prone to hallucination. It stays a manual workflow, not a health input.
- **Per-cell health overrides.** Users cannot manually force a cell's health number. The score is always derived from the signals.
- **Cloud-side computation.** The health worker is a client-side web worker in v1. The `DualIndex` module is DOM-free and portable to a Cloudflare Worker if performance demands it, but that port is out of scope here.
- **Migration of historical `cell.history[*].examples: string[]`.** Pre-migration entries are treated as "no ancestry information" (max `ancestryPenalty`), not back-filled with synthesized weights.
- **UI-editable rule penalties at the rule level.** `rulePenalties.{major, minor}` are project-wide; per-rule severity (major/minor) already lives on each rule and stays there.

---

## Architecture Overview

```
┌─ Project (existing, +1 field) ─────────────────────────────────────────┐
│   completionSettings (- llmHealthPenalty, removed)                     │
│   rules?                                                               │
│   requiredValidations                                                  │
│   experimentalFlags?  ← hosts 'composite-health'                       │
│   healthSettings?: HealthSettings   ← NEW                              │
└────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─ Health worker (NEW, src/workers/health-worker.ts) ────────────────────┐
│  Input: { cells, rules, config }                                       │
│  1. DualIndex.buildFromProject(cells)   ← single pass, both sides      │
│  2. For each cell:                                                     │
│       searchBranchingSource / searchBranchingTarget                    │
│       searchPlainSource     / searchPlainTarget                        │
│  3. checkRules(cells, rules)                                           │
│  4. computeHealthMap (fixed-point ancestry, capped subtractions)       │
│  Output: HealthStats { healthMap, fileHealth, projectHealth,           │
│            breakdownMap, fileProgress, infractions, openCommentCount } │
└────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─ useHealth (existing, rewired) ────────────────────────────────────────┐
│  - Posts {cells, rules, config} to worker on mount + on delta          │
│  - Subscribes to worker output, returns HealthStats                    │
│  - Sync fallback (computeHealthSync) for tests + SSR                   │
└────────────────────────────────────────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
 ┌──────────────┐ ┌────────────┐ ┌─────────────────────┐
 │ HealthRing   │ │ StatusBar  │ │ EditorTable rows    │
 │ (wrapped w/  │ │ (project)  │ │ (per cell)          │
 │  tooltip +   │ │            │ │                     │
 │  popover)    │ │            │ │                     │
 └──────┬───────┘ └─────┬──────┘ └──────┬──────────────┘
        │               │               │
        └───────────────┴───────────────┘
                        ▼
         ┌──────────────────────────────┐
         │ HealthBreakdown (NEW)         │
         │   Tooltip: 4 signed rows      │
         │   Popover: signals + clickable│
         │     neighbor/example cellIds  │
         └──────────────────────────────┘
```

The existing `SearchIndex` at `src/lib/search/search-index.ts` is deleted. `useSearchIndex` (used for few-shot completion retrieval) is rewired to consume `DualIndex.searchBranchingSource` — one source of truth for search, fixing the fresh-file few-shot bug as a side effect.

---

## Scoring Formula

### Per-cell score

```
score = 100
  − validationGap        (cap 60, default)
  − ancestryPenalty      (cap 20, default)
  − neighborhoodPenalty  (cap 25, default)
  − rulePenalty          (cap 40, default)
clamp → [0, 100]
```

Empty cells (no translation) are skipped: they contribute nothing to file/project averages and carry no health value.

### validationGap

```
activeCount     = cell.edits[last-value-entry].validatedBy
                     .filter(v => !v.isDeleted).length
ratio           = min(activeCount / requiredValidations, 1)
validationGap   = caps.validationGap * (1 − ratio)
```

Derivation source: same `cell.edits` structure that today's `validationStatus` reads from, just counted instead of bucketed. `self` / `others` / `full` distinctions remain on `CellData` for UI purposes (pill color, validator names) but do not enter the scoring math.

### ancestryPenalty

Ancestors are the cellIds in the last history entry's `examples`. The schema changes from `string[]` to `{cellId: string, weight: number}[]`:

```
last = cell.history[cell.history.length - 1]
examples = last?.examples ?? []

if examples.length === 0:
  ancestryPenalty = caps.ancestryPenalty       // no lineage information
else if typeof examples[0] === "string":
  ancestryPenalty = caps.ancestryPenalty       // legacy entry, unknown weights
else:
  weightedSum   = Σ healthMap[ex.cellId] * ex.weight    (ex.weight = coverage at generation time)
  weightSum     = Σ ex.weight
  avgExHealth   = weightedSum / weightSum
  ancestryPenalty = caps.ancestryPenalty * (1 − avgExHealth / 100)
```

Computed via iterated relaxation: run the scoring pass up to `MAX_ANCESTRY_ITERATIONS` times (default 3), breaking early if no cell's health changes between iterations. Human-validated cells pin in pass 1 (their score is independent of ancestry); LLM cells stabilize in pass 2; cycles (rare but possible if a user manually edits `cell.history`) converge under the damping that iteration bound provides. Three iterations is sufficient for typical chain depths (1–2); the cap prevents runaway on pathological graphs.

### neighborhoodPenalty

Per cell:

```
S = dualIndex.searchBranchingSource(cell.original, config.neighborhoodSearchLimit)
T = dualIndex.searchBranchingTarget(cell.translated, config.neighborhoodSearchLimit)
S_plain = dualIndex.searchPlainSource(cell.original, config.neighborhoodSearchLimit)
T_plain = dualIndex.searchPlainTarget(cell.translated, config.neighborhoodSearchLimit)

tfidfOverlap = weightedTokenOverlap(S, T)             // branching side carries coverage
idJaccard    = weightedJaccard(S_plain, T_plain)      // ID sets weighted by plain score

wIdf = config.neighborhoodWeights.tfidfTokenOverlap
wId  = config.neighborhoodWeights.idJaccard
total = wIdf + wId
blend = (wIdf * tfidfOverlap + wId * idJaccard) / total   // normalize

neighborhoodPenalty = caps.neighborhoodPenalty * (1 − blend)
```

Either side empty (no neighbors found) → `blend = 0` → max penalty, which is the "fresh project, can't assess consistency" case.

`weightedJaccard` (cell-ID side):

```
∩_weighted = Σ over cellIds in (S_plain ∩ T_plain): min(w_S[id], w_T[id])
∪_weighted = Σ over cellIds in (S_plain ∪ T_plain): max(w_S[id], w_T[id])
weightedJaccard = ∩_weighted / ∪_weighted    (0 if denominator 0)
```

where `w_S[id]` and `w_T[id]` are each neighbor's `coverageWeight` as emitted by `searchPlain*` (score / maxScore in that result set).

`weightedTokenOverlap` (TF-IDF side) — a symmetric, coverage-weighted agreement score in [0, 1]. Let `matchedTokens(S)` and `matchedTokens(T)` be the multisets of tokens each side matched (each token weighted by its source `ScoredPair.coverageWeight`):

```
tokenWeights_S = Σ over p in S: { for each t in p.matchedTokens: t += p.coverageWeight }
tokenWeights_T = Σ over p in T: { for each t in p.matchedTokens: t += p.coverageWeight }

// normalize each side to [0, 1] by dividing by its own total
norm_S = tokenWeights_S / Σ tokenWeights_S.values    (element-wise, zeros pass through)
norm_T = tokenWeights_T / Σ tokenWeights_T.values

// bounded agreement — min on shared tokens, max on union
agreement = Σ over tokens in (keys(norm_S) ∩ keys(norm_T)): min(norm_S[t], norm_T[t])
           / Σ over tokens in (keys(norm_S) ∪ keys(norm_T)): max(norm_S[t], norm_T[t])
```

`agreement` is the final `tfidfOverlap` value, always in [0, 1]. If either side produced no results, `tfidfOverlap = 0`. The blend formula above combines it with `idJaccard`.

### rulePenalty

```
raw = Σ over infractions on this cell:
        rulePenalties.major    if rule.severity === "major"
        rulePenalties.minor    if rule.severity === "minor"
rulePenalty = min(raw, caps.rulePenalty)
```

Unchanged in structure from today, new only in the cap.

### File & project aggregation

File and project health are still `mean(healthMap[cell.id])` over non-empty cells, unchanged. `breakdownMap` provides per-dimension averages at file and project level, plus a "biggest drags" list: top-3 cells by summed penalty.

### Cross-viewer determinism

Every input to the score is Yjs-derived and user-independent: `cell.edits`, `cell.history`, `rules`, `requiredValidations`, `cells` corpus. No dependence on current username. Two users looking at the same Yjs state see identical numbers.

---

## Config Schema, Defaults, Persistence, Reset

### Defaults file — `src/lib/health/defaults.ts`

```ts
export interface HealthCaps {
  validationGap: number
  ancestryPenalty: number
  neighborhoodPenalty: number
  rulePenalty: number
}

export interface RulePenaltiesConfig {
  major: number
  minor: number
}

export interface NeighborhoodWeights {
  idJaccard: number
  tfidfTokenOverlap: number
}

export interface HealthConfig {
  caps: HealthCaps
  rulePenalties: RulePenaltiesConfig
  neighborhoodWeights: NeighborhoodWeights
  neighborhoodSearchLimit: number
}

export const HEALTH_DEFAULTS: HealthConfig = {
  caps: {
    validationGap: 60,
    ancestryPenalty: 20,
    neighborhoodPenalty: 25,
    rulePenalty: 40,
  },
  rulePenalties: { major: 15, minor: 5 },
  neighborhoodWeights: { idJaccard: 0.5, tfidfTokenOverlap: 0.5 },
  neighborhoodSearchLimit: 5,
}
```

### Project-level persistence

A new optional top-level field on `Project`:

```ts
interface HealthSettings {
  followDefaults: boolean                // default true on creation
  overrides?: DeepPartial<HealthConfig>  // only fields the user has touched
}

interface Project {
  // ...existing
  healthSettings?: HealthSettings
}
```

Stored in the existing Yjs project map — same mechanism as `completionSettings`.

### Resolution

```ts
function resolveHealthConfig(project: Project): HealthConfig {
  const s = project.healthSettings
  if (!s || s.followDefaults) return HEALTH_DEFAULTS
  return deepMerge(HEALTH_DEFAULTS, s.overrides ?? {})
}
```

### Two states, two controls

| Intent | `followDefaults` | `overrides` | Effect |
|--------|------------------|-------------|--------|
| Auto-follow future defaults (new projects) | `true` | preserved but unused | `HEALTH_DEFAULTS` |
| Custom tuning | `false` | populated | `defaults + overrides` |
| Rebaseline while keeping custom mode | `false` | `{}` | `defaults`, but drift-prone |

**"Follow defaults" toggle** flips `followDefaults`. When flipped from `false → true`, `overrides` is preserved so flipping back restores them without data loss.

**"Reset overrides" button** clears `overrides` without touching `followDefaults`, behind a confirm dialog.

Editing any field in the Health Settings UI automatically flips `followDefaults → false`, with a one-time inline notice: *"This project will no longer auto-follow default changes."* The notice is dismissible and does not block the edit.

### Migration from `completionSettings.llmHealthPenalty`

The existing field is **dropped**, not translated. The new model's `ancestryPenaltyCap` uses a fundamentally different formula and mapping old values yields no defensible numbers.

Migration is **gated by the `composite-health` flag** so the flag-off legacy path continues to work against existing project state:

- **While the flag is off** (default): `completionSettings.llmHealthPenalty` remains readable, the old `LLM Health Penalty` slider remains in `ProjectSettings`, `useHealth` uses the legacy path. No data mutation.
- **On first flag-on for a project**: `healthSettings` is initialized to `{ followDefaults: true }` if absent. `completionSettings.llmHealthPenalty` is **left in place** (not deleted) so flipping the flag back off continues to work; it is simply ignored by the new path.
- **When the flag becomes default-on + one release cycle later**: the legacy code path, the old slider, and the `completionSettings.llmHealthPenalty` field are all removed. That cleanup is a separate follow-up PR, not part of this spec's implementation.

Existing projects will see their health numbers shift the moment they flip the flag. This is inherent to the redesign and is acceptable because the dimensions are fundamentally different.

---

## Neighborhood Signal: Dual Index + Worker

### `DualIndex` — `src/lib/search/dual-index.ts`

Replaces `SearchIndex`. Maintains per-cell source and target tokenizations, with per-side inverted indexes for O(1) candidate lookup during search.

```ts
export interface IndexedPair {
  cellId: string
  fileId: string
  sourceTokens: Set<string>
  targetTokens: Set<string>
}

export interface ScoredPair {
  cellId: string
  fileId: string
  source: string
  target: string
  score: number
  matchedTokens: string[]
  coverageWeight: number   // branching: coveredSpanTokens / queryTokens
                           // plain:    score / maxScoreInResultSet
}

export class DualIndex {
  private pairs = new Map<string, IndexedPair>()
  private sourceInverted = new Map<string, Set<string>>()
  private targetInverted = new Map<string, Set<string>>()
  private sourceDocFreq = new Map<string, number>()
  private targetDocFreq = new Map<string, number>()
  private docCount = 0

  buildFromProject(cells: CellInput[]): void       // single pass, both sides
  addPair(cell: CellInput): void
  removePair(cellId: string): void

  searchBranchingSource(query: string, limit: number): ScoredPair[]
  searchBranchingTarget(query: string, limit: number): ScoredPair[]
  searchPlainSource(query: string, limit: number): ScoredPair[]
  searchPlainTarget(query: string, limit: number): ScoredPair[]
}
```

`searchBranching*` ports today's branching loop (with `findLongestCoveredSubstring`) but now emits `coverageWeight` per result. `searchPlain*` is the same scoring loop without the branch-and-restart wrapper — a single pass ranking over inverted-index candidates.

Only cells with non-empty `original` AND non-empty `translated` are indexed (same guard as today, applied to both sides).

### `useSearchIndex` rewired

`useSearchIndex` (currently imports `SearchIndex`) now imports `DualIndex` and routes `search(query, limit)` to `dualIndex.searchBranchingSource(query, limit)`. Its `_files` argument is finally used: the index is built from all cells across all files, not just `currentCells`. The fresh-file few-shot bug resolves as a side effect.

### Health worker — `src/workers/health-worker.ts`

```ts
// worker input / output
export interface HealthWorkerRequest {
  type: "build" | "update" | "score"
  cells?: CellInput[]
  rules?: TranslationRule[]
  config?: HealthConfig
  deltaCellIds?: string[]
}

export interface HealthWorkerResponse {
  type: "stats"
  stats: HealthStats
}
```

Lifecycle:

1. On project open, main thread posts `{type: "build", cells, rules, config}`.
2. Worker runs `DualIndex.buildFromProject`, then per-cell dual search, `checkRules`, and `computeHealthMap`. Posts back `{type: "stats", stats}`.
3. On cell edit, main thread posts `{type: "update", deltaCellIds: [id]}`. Worker `removePair(id)` + `addPair(newCell)`, re-runs search + scoring only for cells whose dependencies touched the delta (conservatively: all cells in the same file, plus cells referencing this one in their `examples`).
4. On config change or rule change, main thread posts `{type: "score", rules, config}` — index is unchanged, only scoring re-runs.

Index is kept hot in the worker between messages. The main thread holds no index; `useSearchIndex` queries go through a separate message channel (`{type: "search", mode, query, limit}`) to avoid duplicating the index on the main thread.

### Sync fallback

`src/workers/health-worker-sync.ts` exports `computeHealthSync(request): HealthStats` running the same pipeline synchronously. Used in Vitest (where `Worker` is not available) and as an SSR escape hatch. `useHealth` dispatches based on `typeof Worker !== "undefined"`.

### Cost estimate

For a 30k-cell corpus (large bible):
- Tokenization: ~50 ms single pass
- `buildFromProject`: fits in <20 MB
- Dual search per cell: ~1–2 ms with inverted-index candidate filtering
- Full-project scoring pass: ~30–60 s initial, in-worker, non-blocking

Incremental updates after the initial build are near-instant because only the delta cell's search runs fresh.

---

## Hover Breakdown UI

### `HealthRing` wrapping

`HealthRing` remains an SVG primitive. A new wrapper component `HealthBreakdown.tsx` renders the ring plus wires up tooltip + popover:

```tsx
<HealthBreakdown cellId={cell.id} scope="cell" /* or "file" | "project" */>
  <HealthRing health={health} />
</HealthBreakdown>
```

Hover → shadcn `Tooltip` with glance view.
Click → shadcn `Popover` with detail view.

### Tooltip (glance)

```
┌────────────────────────┐
│      72                │
│                        │
│  Reviewed       −0     │
│  Examples       −5     │
│  Consistency  −15      │
│  Rules          −8     │
└────────────────────────┘
```

Number prominent at top (display size). Four rows below, monospace-aligned signed values. No button, no hint text — a subtle chevron on the ring indicates a popover exists.

### Popover (detail)

Width ~360px. Sections are collapsible (`Collapsible`), expanded by default.

```
┌────────────────────────────────────┐
│        72                          │
│      cell health                   │
│  ──────────────────────────────   │
│  Reviewed                    −0    │
│  Fully reviewed  ·  2 validators   │
│                                    │
│  Examples                    −5    │
│  Strong lineage                    │
│    GEN 1:1     100                 │
│    GEN 1:3      15                 │
│    + 3 more                        │
│                                    │
│  Consistency                −15    │
│  Weak agreement                    │
│    Source neighbors: 5             │
│    Target neighbors: 5             │
│    Overlap: 3                      │
│    ID Jaccard: 0.40                │
│    TF-IDF:     0.55                │
│                                    │
│  Rules                       −8    │
│    Capitalization        minor     │
│    Trailing whitespace   minor     │
└────────────────────────────────────┘
```

Each section shows:
1. **Label + signed penalty** (primary row)
2. **Qualitative description** from magnitude bands (one short line)
3. **Supporting evidence** (scrollable / "+N more" if long)

Magnitude bands:

| Dimension | 0 / low / mid / high |
|-----------|----------------------|
| Reviewed | "Fully reviewed" / "Partially reviewed" / "Not yet reviewed" |
| Examples | "Strong lineage" / "Mixed lineage" / "Weak lineage" / "No examples" |
| Consistency | "Strong agreement" / "Some agreement" / "Weak agreement" / "No neighbors found" |
| Rules | "Clean" / "Minor issues" / "Major issues" |

### Clickable neighbor and example cellIds

Each cellId in the popover renders as a text link. Click behavior:

1. Close popover.
2. Invoke `jumpToCell(cellId)` — existing primitive used by `Cmd+.` next-unfinished navigation.
3. Target cell scrolls into view and briefly highlights.

### File and project scope

Same wrapper, different content:

```
┌────────────────────────────────────┐
│          64                        │
│     project health                 │
│  ──────────────────────────────   │
│  Reviewed       avg −22            │
│  Examples       avg −4             │
│  Consistency    avg −7             │
│  Rules          avg −3             │
│                                    │
│  Biggest drags on health:          │
│    GEN 3:14   34                   │
│    EXO 12:8   41                   │
│    MAT 5:3    48                   │
└────────────────────────────────────┘
```

"Biggest drags" = top 3 cells by sum of all four dimension penalties (equivalently, `100 − score` for non-empty cells). Clickable, jumps to cell.

### No live computation on hover

The breakdown is pre-computed by the worker as part of `HealthStats.breakdownMap`. Tooltip and popover read from memory; there is no search or scoring triggered by UI interaction.

---

## Testing Strategy

### Layer 1 — scoring engine (`src/lib/health/health-engine.test.ts`, rewritten)

Each dimension isolated (others held at zero):

- `validationGap`: 0/N, 1/N, N/N, excess/N boundary cases
- `ancestryPenalty`: no examples; one high-coverage high-health example dominates; nine low-coverage low-health examples contribute little; legacy `string[]` entries → max cap
- `neighborhoodPenalty`: empty S; empty T; identical 5-cell sets; partial overlap; weight toggles
- `rulePenalty`: no rules; N minor; enough majors to hit cap

Composite cases:
- Fully validated + clean → 100
- Fully validated + 2 major rules → 100 − 30 = 70
- Unvalidated LLM cell, strong ancestry, strong neighborhood → ≈ 40
- Worst case → 0 (clamped, not negative)
- Fixed-point ancestry: three-cell chain where root is validated; assert propagation

### Layer 2 — `DualIndex` (`src/lib/search/dual-index.test.ts`)

- Build determinism: incremental add/remove equals full rebuild
- `coverageWeight` emission in both modes; branching sums to ≤ 1
- `weightedJaccard`: 1.0 on identical, 0.0 on disjoint, asymmetric weights
- Small bilingual fixture: exercise all four search entry points; snapshot top-5

### Layer 3 — worker integration (`src/workers/health-worker.test.ts`)

- Sync export path round-trips `{cells, rules, config} → HealthStats`
- Incremental update: mutate one cell; only its entry changes in `breakdownMap`
- Reactive path via `useHealth`: render with RTL, mutate via Yjs, assert re-render

### Layer 4 — config resolution (`src/lib/health/config.test.ts`)

- `followDefaults: true` → always defaults
- `followDefaults: false, overrides: {caps: {rulePenalty: 50}}` → that field shifts, others unchanged
- `overrides: {}` under custom mode → equal to defaults
- Migration path: old `llmHealthPenalty` field stripped; `healthSettings` initialized

### Layer 5 — UI smoke (`src/components/HealthBreakdown.test.tsx`)

- Tooltip renders 4 rows with correct signed values
- Popover renders sections with correct band descriptions
- Clickable cellIds trigger `jumpToCell` spy
- Project-level variant renders "biggest drags"

### Out of scope for v1 tests

- Performance benchmarks at 30k cells — a follow-up investigation if complaints surface
- Tokenization edge cases — existing tokenizer coverage is sufficient

### TDD sequence

1. Scoring engine unit tests + engine rewrite
2. `DualIndex` tests + class
3. Worker integration
4. Config resolution + persistence
5. UI

This order gets the most bug-prone code under test first.

---

## Rollout — `composite-health` Experimental Flag

Follows the pattern established by Living Memory (`src/lib/features/flags.ts`). New registry entry:

```ts
{
  id: "composite-health",
  label: "Composite health scoring",
  description: "Replaces validation-as-override with a four-dimension composite score.",
}
```

When the flag is **off** (default), `useHealth` runs the existing legacy code path, untouched. Health values and UI match current behavior.

When the flag is **on** for a project:
- `useHealth` dispatches to the new worker pipeline
- `HealthRing` is wrapped by `HealthBreakdown`
- `ProjectSettings` renders `HealthSettingsSection` (replacing the old `llmHealthPenalty` slider)

This lets us dogfood on internal projects first, gather feedback on the caps defaults, and flip to default-on once signals settle. The legacy path stays in the codebase until the flag is default-on + a release cycle has passed, then gets removed.

---

## Open Questions / Future Work

- **Cloudflare-side computation** if the client worker is too slow for very large corpora. `DualIndex` is portable; the port is a separate spec.
- **Embedding-based consistency** as an optional fifth dimension once a deterministic, cheap embedding path exists (Matryoshka? On-device?). Would plug into the same capped-subtraction model.
- **Per-dimension curve shape** (linear vs. quadratic) as a configurability axis. Not in v1 — current defaults are all linear in their underlying signal.
- **Rule-aware weighting of ancestry / neighborhood.** If a cell's problem is overwhelmingly rule-based, should ancestry / neighborhood contributions shrink? Probably handled by rule-aware prompts at generation time rather than at scoring time. Noted for later.
- **Historical health trends.** Once `cell.edits` carries full history, we can plot health-over-time for a cell and a project. Orthogonal to this spec.
