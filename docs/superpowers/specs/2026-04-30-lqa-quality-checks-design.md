# Codex Web App — LQA & Translation Quality Management

## Overview

Add a layered LQA (Linguistic Quality Assurance) system on top of the existing rule engine. Two layers:

1. **Algorithmic checks** — universal, language-agnostic heuristics that run with zero user setup. Toggleable per-project, severity-adjustable. Source-tagged `"algorithmic"`.
2. **Configured data** — user-supplied glossary, do-not-translate, translation memory. Compiled into rules at runtime.

Performance is the load-bearing constraint: keystroke latency must stay flat. The hot path runs only per-cell checks; cross-cell analytics live in a Web Worker, debounced.

## Goals

- Catch ~80% of common LQA defects without any project setup.
- Layer configured data (glossary/DNT/TM) on top, sharing the same engine, UI, and penalty math.
- Zero regression on editor latency; cross-cell checks must not block typing.

## Non-Goals (v1)

- Translation Memory full implementation (deferred to v2).
- ML-based semantic similarity (LaBSE/SONAR) and back-translation sampling (deferred, behind `experimentalFlags`).
- TF-IDF statistical term-consistency (deferred — wait for project corpus to exist; v1 ships exact-match `inconsistent-translation` instead).
- Spell/grammar checking (per-language dictionaries unavailable for most Codex target languages).

## Architecture

The existing `src/lib/rules/rule-engine.ts` already supports per-cell incremental evaluation with a compiled-regex cache, severity, autofix, waivers, and a UI surface (`RuleDrawer`, `RulesPage`, `ViolationPopover`, `HealthBreakdown`). We extend it; we do not parallel-build.

### Three execution tiers

| Tier | When it runs | Scope | Examples |
|---|---|---|---|
| **Hot** | `checkRulesForCell` on every keystroke (debounced upstream) | Pure per-cell; reads precomputed AnalyticsContext if needed | placeholder, number, empty-target, target-equals-source, end-punctuation, double-space, repeated-word, unpaired-symbols, abbreviation, glossary, DNT |
| **Idle** | Web Worker, debounced 1.5s after edit; also on file-open and manual "Recompute" | Cross-cell bootstrap + per-cell checks that need it | duplicate-target, inconsistent-translation, length-ratio, segment-count, wrong-language-detected, script-leakage |
| **On-demand (v2)** | Manual button or scheduled review | Sampled / expensive | LaBSE semantic similarity, back-translation, NER pass-through, TF-IDF term-consistency |

The Idle tier produces a `cellId → AnalyticsContext` map that the Hot tier reads in O(1). Hot tier never blocks on cross-cell context — when context is missing, those checks no-op until the worker delivers.

### Data flow

```
keystroke
  → useCells writes Y.Doc
  → checkRulesForCell(cell, fileId, enabledRules, analyticsContext)  [hot path]
  → infractions for that cell only
  → health-engine applies penalties → editor renders

idle (debounced 1.5s) OR file-open OR manual "Recompute"
  → projectAnalyticsWorker.compute(allCells)
  → returns AnalyticsContext { duplicateTargets, sourceTargetMap, lengthNorms, languageGuesses, ... }
  → main thread merges → checkRules re-runs across all cells (also off-thread, results posted back)
  → infraction map updated; editor re-renders affected cells only
```

## Algorithmic check types (v1)

Extend `RuleCheck` with new variants. Each has a stable `id` (string) so users' enable/severity overrides survive across versions.

### Group A — Structural (Hot tier, trivial)

| id | Detects |
|---|---|
| `empty-target` | Source has content; target is empty or whitespace-only |
| `target-equals-source` | Target text is byte-identical to source (untranslated) |
| `segment-count` | (Idle, file-scope) Translated cell count diverges from expected — only meaningful for paired-source files |

### Group B — Content integrity (Hot tier, string ops)

| id | Detects |
|---|---|
| `placeholder-integrity` | Tokens like `{var}`, `<tag>`, `%s`, `%1$s`, `\n`, `«»`, `&amp;`, `&nbsp;` present in source must be present in target. Subchecks: presence, ordering (when ordinal markers like `%1$s` are used), spacing-around. |
| `number-integrity` | Numerals in source must appear in target. Locale-tolerant (`1,000`↔`1.000`). Sub-flags: digit-to-word divergence, sign drop (`+`/`-`/`%`). |
| `unpaired-symbols` | Unmatched `()`, `[]`, `{}`, `«»`, `""`, `''` in target free text. |
| `abbreviation-mismatch` | All-caps tokens in source (`LORD`, `USA`, `NT`) absent from target — flagged at minor severity, easily waivable. |

### Group C — Whitespace / punctuation (Hot tier)

| id | Detects |
|---|---|
| `end-punctuation-mismatch` | Source ends in `?`/`!`/`.`/`…`, target does not (or vice versa). Locale-aware: Spanish `¿…?` `¡…!`, RTL marks, CJK `。？！` |
| `double-space` | Multiple consecutive whitespace chars; leading/trailing whitespace |
| `repeated-word` | Same token repeated consecutively (`the the`). Suppressed when source has the same repetition. |

### Group D — Cross-segment (Idle tier, Worker)

| id | Detects |
|---|---|
| `duplicate-target` | Same target string used for two distinct sources (in same file) |
| `inconsistent-translation` | Same source string rendered differently across cells (file-scoped exact match; statistical version is v2) |
| `length-ratio` | Z-score outliers vs. file's bootstrapped source→target ratio. Norm computed once enough cells exist (≥30); below threshold the check no-ops. |
| `script-leakage` | Target contains chars from a Unicode script that is not the project's expected target script. Expected script bootstrapped from majority of validated cells. |

### Group E — Language detection (Idle tier)

| id | Detects |
|---|---|
| `wrong-language-detected` | `franc`-style language ID on the target segment doesn't match `ProjectRecord.targetLanguage`. Run only on cells ≥ ~25 chars to avoid noise. Use [`franc`](https://www.npmjs.com/package/franc) (~50KB compressed; 200+ languages). |

## Configured layer (v1)

### Glossary

```typescript
interface GlossaryEntry {
  id: string
  sourceTerm: string                    // exact or regex; default exact, case-insensitive
  targetRenderings: string[]            // any of these in target satisfies the check
  status: "approved" | "candidate"      // candidate = suggested, not yet locked
  notes?: string
  createdAt: string
  createdBy?: string
}

interface ProjectRecord {
  // ... existing fields ...
  glossary?: GlossaryEntry[]
}
```

Glossary entries are compiled into `source-requires-target` checks at runtime — no new check kind needed in the engine. The compiler escapes `sourceTerm` for use as a regex unless an opt-in `regex: true` flag is added later. `targetRenderings` becomes an alternation: `(rendering1|rendering2)`.

### Do-Not-Translate

A degenerate glossary entry where `targetRenderings = [sourceTerm]` (verbatim match). The Glossary UI exposes a "Do not translate" toggle that sets this automatically.

### Algorithmic-check overrides

```typescript
interface AlgorithmicCheckOverride {
  enabled: boolean
  severity?: "major" | "minor"   // omit to keep default
}

interface ProjectRecord {
  // ...
  algorithmicChecks?: Record<string, AlgorithmicCheckOverride>  // keyed by check id
}
```

Defaults live in `src/lib/lqa/defaults.ts` (analogous to `src/lib/health/defaults.ts`). Resolution: project override wins; absent → default.

## UI Surface

- **`RulesPage`** gets a new "Built-in checks" section above the existing user-rule list. Each check renders as a row with: name, description, default severity, severity dropdown (override), enable/disable toggle, "X violations across project" count. No editing of regex internals — these are managed.
- **`Settings → Glossary`** — new sub-page under `ProjectSettings`. Table view: source term, target renderings (chips), status, last updated. Bulk import from CSV/TSV. "Do not translate" quick-toggle creates the degenerate entry.
- **Editor inline** — glossary terms get a subtle highlight in source side; click → popover showing approved renderings. Same `ViolationPopover` infrastructure as rules.
- **`HealthBreakdown`** — `signals.infractions` already lists infractions; new check ids surface there with no UI change required.

## Performance budget

- **Hot tier per-cell budget:** ≤ 0.5ms per cell at the 95th percentile, single-threaded. Tier-1 checks are O(len) and avoid per-call regex compilation via the existing cache.
- **Idle tier:** runs in `lqaAnalyticsWorker.ts`. Debounced 1.5s after the last keystroke in a project. Re-runs incrementally when feasible; full pass otherwise. Worker output is a structured-clonable plain-object map merged onto the main thread.
- **Worker payload:** sends only `{ cellId, source, target, fileId }` arrays — no Y.Doc, no history, no audio.
- **Memory:** AnalyticsContext capped at one entry per cell; per-cell payload < 200 bytes.

The existing per-keystroke `checkRulesForCell` path already runs synchronously on the main thread without animation jank — adding ~10 string-only checks per cell is well within budget. Profiling is part of the implementation acceptance criteria.

## Composite-health integration

New algorithmic check ids feed `RuleInfraction` exactly like existing rules. The composite health scorer (`src/lib/health/composite/`) treats them as any other infraction — no scorer changes needed. Penalty defaults: minor=5, major=15 (existing).

Suggested defaults per check (severity, enabled-by-default):

| Check | Severity | Default |
|---|---|---|
| `empty-target` | major | on |
| `target-equals-source` | major | on |
| `placeholder-integrity` | major | on |
| `number-integrity` | major | on |
| `end-punctuation-mismatch` | minor | on |
| `unpaired-symbols` | minor | on |
| `repeated-word` | minor | on |
| `double-space` | minor | on |
| `abbreviation-mismatch` | minor | off (high false-positive in some target languages) |
| `script-leakage` | major | on |
| `duplicate-target` | minor | on |
| `inconsistent-translation` | minor | on |
| `length-ratio` | minor | off until ≥30 translated cells in file (auto-enables) |
| `wrong-language-detected` | major | on |
| `segment-count` | minor | on |

## Sync & migration

- `glossary` and `algorithmicChecks` are added to `ProjectRecord`. Existing projects without these fields fall back to defaults.
- Glossary entries sync via the existing y-partyserver project-record flow. No new persistence.
- No migration required — additive fields with safe defaults.

## Phasing

### v1 (this spec)

- All Group A/B/C/D/E checks listed above.
- Glossary + DNT data model and minimal UI.
- Worker for Idle-tier checks.
- `RulesPage` "Built-in checks" section.

### v2 (future)

- TF-IDF statistical term-consistency (extension of `inconsistent-translation`).
- Translation Memory (fuzzy match against validated cells; suggestion source + consistency check).
- LaBSE semantic similarity (sampled, opt-in).
- Back-translation spot-check.
- NER proper-noun pass-through (likely paired with TM).
- Glossary suggestion via LLM (mine candidates from corpus).

## Open questions

1. **Desktop codex-editor parity** — no codex-editor checkout was available locally. Before merging, confirm field names against the desktop extension's glossary shape, if one exists. (Memory: "Always check codex-editor desktop app".)
2. **Whether `franc` is the right language-ID library** — alternatives: `lingua-js` (more accurate, larger). Pick one in the implementation plan after a size+coverage check for the project's typical target languages.
3. **Org-level glossary** (parallel to org-rules stub) — not in v1; flag for v2 if community-shared glossaries become a request.

## Acceptance criteria

- All v1 checks land with unit tests covering true positives, true negatives, and at least one tricky case per check (e.g., locale punctuation, RTL).
- A Cypress/Playwright test for the editor verifies that running the new built-ins on a 1000-cell file does not regress keystroke latency by more than 5% vs. main.
- The Glossary page can: add, edit, delete, bulk-import (CSV), toggle DNT.
- A glossary violation appears as a `RuleInfraction` with a `ViolationPopover` showing approved renderings.
- All checks are individually toggleable from `RulesPage`.
