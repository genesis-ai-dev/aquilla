# Paragraph-Drafting Phase 0 (prompt-only wins) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the *current per-cell* AI draft by feeding it the committed target of preceding cells (discourse context), compressing retrieved few-shot examples, and making the context budget a project setting — with no segmentation, retrieval, or event-model changes.

**Architecture:** All changes live in the completion path (`useCompletion.ts` → `completion-service.ts`) plus two new pure-function modules and one settings field. Source-side example retrieval already exists (`branchingSearch` → server FTS, returning paired source/target + `matchedTokens`); we consume its provenance for compression rather than rebuild it. The single-cell prompt builder gains a `precedingContext` slot rendered closest to the live source (the strongest continuity signal).

**Tech Stack:** TypeScript, React hooks, Vitest, happy-dom. No new dependencies.

## Global Constraints

- **Spec of record:** `docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md`. Each task implements the cited decision (D4/D6/D10) and MUST carry the spec's rationale comment verbatim-in-spirit at the decision site.
- **Surgical changes only** (CLAUDE.md Rule 3): touch only the listed lines; do not reformat or "improve" adjacent code.
- **No segmentation / retrieval / event-model changes** — those are Phase 1.
- **Compression is deterministic** (selection/truncation), never model summarization; the `bt-glosser` Markov aligner stays out of this path (D8).
- **v1 budget unit = cell count, not tokens.** This intentionally simplifies D10 (which specified tokens) to avoid a tokenizer dependency; token budgets are a later refinement. Note this in the setting's doc comment.
- **Terminology elision (D7) is deferred** out of Phase 0 — lowest value, needs the compiled legend at the call site. Not in this plan.
- Test runner: `pnpm vitest run <path>`. Type check: `pnpm tsc -b` (or the repo's `pnpm typecheck` if present).
- Commit messages: conventional commits; end the body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- **Create** `src/lib/completion/compress-examples.ts` — pure source-span compression + dedupe (Task 1).
- **Create** `src/lib/completion/draft-context.ts` — `DraftContextSettings`, defaults, `gatherPrecedingContext` (Task 2).
- **Modify** `src/lib/sync/project-settings.ts` — add `draftContext?` to `ProjectWideSettings` (Task 3).
- **Modify** `src/lib/completion/completion-service.ts` — add `precedingContext` to `buildPrompt` and render it (Task 4).
- **Modify** `src/hooks/useCompletion.ts` + `src/components/ProjectWorkspace.tsx` — wire it together (Task 5).
- Tests: `src/lib/completion/__tests__/compress-examples.test.ts`, `src/lib/completion/__tests__/draft-context.test.ts`, and additions to the existing completion-service test file.

Tasks 1–4 are independent (different files / an isolated function); Task 5 integrates and depends on all of them.

---

### Task 1: Example compression module

**Files:**
- Create: `src/lib/completion/compress-examples.ts`
- Test: `src/lib/completion/__tests__/compress-examples.test.ts`

**Interfaces:**
- Produces: `compressExampleSource(source: string, opts?: CompressExampleOptions): string` and `dedupeExamples<T extends { source: string }>(examples: T[]): T[]`, where `CompressExampleOptions = { matchedTokens?: string[]; keepWholeUnder?: number; marginChars?: number }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/completion/__tests__/compress-examples.test.ts
import { describe, it, expect } from "vitest"
import { compressExampleSource, dedupeExamples } from "../compress-examples"

describe("compressExampleSource", () => {
  it("returns short source unchanged (no truncation needed)", () => {
    const s = "In the beginning God created the heavens and the earth."
    expect(compressExampleSource(s, { matchedTokens: ["god"] })).toBe(s)
  })

  it("keeps the matched span and elides head and tail with an ellipsis", () => {
    const long =
      "Now it came to pass in those distant days that a certain man traveled far " +
      "and the COVENANT was established between them forever " +
      "and afterwards the people returned to their tents and dwelt in peace for many years."
    const out = compressExampleSource(long, { matchedTokens: ["covenant"], keepWholeUnder: 80, marginChars: 20 })
    expect(out).toContain("COVENANT")
    expect(out.startsWith("…")).toBe(true)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThan(long.length)
  })

  it("does not cut mid-word (snaps to a boundary char)", () => {
    const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november"
    const out = compressExampleSource(long, { matchedTokens: ["hotel"], keepWholeUnder: 20, marginChars: 8 })
    // every retained token is whole — no partial word fragments
    for (const frag of out.replace(/…/g, " ").trim().split(/\s+/)) {
      expect(long).toContain(frag)
    }
  })

  it("falls back to head+ellipsis when no matched tokens are supplied", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"
    const out = compressExampleSource(long, { keepWholeUnder: 20 })
    expect(out.endsWith("…")).toBe(true)
    expect(out.startsWith("one")).toBe(true)
  })
})

describe("dedupeExamples", () => {
  it("drops later duplicates by normalized source, keeping the first", () => {
    const out = dedupeExamples([
      { source: "the LORD said", target: "A" },
      { source: "the  LORD   said", target: "B" }, // whitespace-normalized dup
      { source: "and it was so", target: "C" },
    ])
    expect(out.map((e) => e.target)).toEqual(["A", "C"])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/completion/__tests__/compress-examples.test.ts`
Expected: FAIL — `Cannot find module '../compress-examples'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/completion/compress-examples.ts

// Few-shot examples are retrieved source-side (branching-search) and can be long
// passages. We compress the INVARIANT (examples) so the freed budget can hold the
// VARIANT (the discourse window). Compression is deterministic selection/truncation
// — NEVER summarization through a weak model — and only the example SOURCE is cut;
// the (small) target is left whole, because target-side truncation would need
// within-cell alignment we don't trust on low-resource languages.
// See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D6, D8).

/** Boundary chars (ordered like text-splitter's BREAK_PATTERNS) used to snap an
 *  ellipsis cut to a natural edge instead of mid-word. */
const BOUNDARY_RE = /[\s.!?;:,—-]/

export interface CompressExampleOptions {
  /** Tokens that matched the query (branching-search provenance) — locate the span to keep. */
  matchedTokens?: string[]
  /** Return the source unchanged when its length ≤ this. Default 160. */
  keepWholeUnder?: number
  /** Chars of margin kept on each side of the matched span. Default 60. */
  marginChars?: number
}

function snapForward(text: string, idx: number): number {
  for (let i = Math.max(0, idx); i < text.length; i++) if (BOUNDARY_RE.test(text[i])) return i
  return text.length
}

function snapBackward(text: string, idx: number): number {
  for (let i = Math.min(text.length, idx); i > 0; i--) if (BOUNDARY_RE.test(text[i])) return i + 1
  return 0
}

function headWithEllipsis(text: string, max: number): string {
  const cut = snapBackward(text, max)
  return text.slice(0, cut > 0 ? cut : max).trim() + "…"
}

export function compressExampleSource(source: string, opts: CompressExampleOptions = {}): string {
  const keepWholeUnder = opts.keepWholeUnder ?? 160
  const marginChars = opts.marginChars ?? 60
  if (source.length <= keepWholeUnder) return source

  const tokens = (opts.matchedTokens ?? []).map((t) => t.toLowerCase()).filter(Boolean)
  if (!tokens.length) return headWithEllipsis(source, keepWholeUnder)

  const lower = source.toLowerCase()
  let first = Infinity
  let last = -1
  for (const tok of tokens) {
    const i = lower.indexOf(tok)
    if (i === -1) continue
    first = Math.min(first, i)
    last = Math.max(last, i + tok.length)
  }
  if (last === -1) return headWithEllipsis(source, keepWholeUnder)

  const start = snapBackward(source, Math.max(0, first - marginChars))
  const end = snapForward(source, Math.min(source.length, last + marginChars))
  const head = start > 0 ? "…" : ""
  const tail = end < source.length ? "…" : ""
  return head + source.slice(start, end).trim() + tail
}

/** Drop examples whose whitespace-normalized source duplicates an earlier one
 *  (keep the first = highest-ranked). */
export function dedupeExamples<T extends { source: string }>(examples: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const ex of examples) {
    const key = ex.source.trim().toLowerCase().replace(/\s+/g, " ")
    if (!key || seen.has(key)) {
      if (key) continue
    }
    seen.add(key)
    out.push(ex)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/completion/__tests__/compress-examples.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/completion/compress-examples.ts src/lib/completion/__tests__/compress-examples.test.ts
git commit -m "feat(completion): deterministic source-span compression for few-shot examples

Truncates long retrieved example sources around their matched span (D6);
target left whole, no model summarization (D8).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Preceding-context module

**Files:**
- Create: `src/lib/completion/draft-context.ts`
- Test: `src/lib/completion/__tests__/draft-context.test.ts`

**Interfaces:**
- Produces:
  - `interface DraftContextSettings { precedingTargetCells: number }`
  - `const DEFAULT_DRAFT_CONTEXT: DraftContextSettings` (`{ precedingTargetCells: 3 }`)
  - `gatherPrecedingContext(cells, cellId, count): { source: string; target: string }[]` where each cell has at least `{ id: string; fileId: string; original: string; translated: string }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/completion/__tests__/draft-context.test.ts
import { describe, it, expect } from "vitest"
import { gatherPrecedingContext, DEFAULT_DRAFT_CONTEXT } from "../draft-context"

const cell = (id: string, fileId: string, original: string, translated: string) =>
  ({ id, fileId, original, translated })

describe("gatherPrecedingContext", () => {
  const cells = [
    cell("a", "f1", "v1 src", "v1 tgt"),
    cell("b", "f1", "v2 src", "v2 tgt"),
    cell("c", "f1", "v3 src", ""),        // uncommitted — skipped
    cell("d", "f1", "v4 src", "v4 tgt"),
    cell("x", "f2", "other", "other tgt"), // different file — ignored
  ]

  it("returns the N committed cells immediately preceding the target, in document order", () => {
    const out = gatherPrecedingContext(cells, "d", 3)
    // 'c' has no target and is skipped; preceding committed are a, b (doc order)
    expect(out).toEqual([
      { source: "v1 src", target: "v1 tgt" },
      { source: "v2 src", target: "v2 tgt" },
    ])
  })

  it("never crosses a file boundary", () => {
    const out = gatherPrecedingContext(cells, "a", 3)
    expect(out).toEqual([]) // nothing precedes 'a' within f1
  })

  it("respects the count cap (most recent first-in-order)", () => {
    const many = Array.from({ length: 6 }, (_, i) => cell(`c${i}`, "f1", `s${i}`, `t${i}`))
    const out = gatherPrecedingContext(many, "c5", 2)
    expect(out).toEqual([
      { source: "s3", target: "t3" },
      { source: "s4", target: "t4" },
    ])
  })

  it("returns [] for count <= 0 or unknown cellId", () => {
    expect(gatherPrecedingContext(cells, "d", 0)).toEqual([])
    expect(gatherPrecedingContext(cells, "nope", 3)).toEqual([])
  })

  it("ships a sane default budget", () => {
    expect(DEFAULT_DRAFT_CONTEXT.precedingTargetCells).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/completion/__tests__/draft-context.test.ts`
Expected: FAIL — `Cannot find module '../draft-context'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/completion/draft-context.ts

// Left-context for a draft is the COMMITTED TARGET of the immediately preceding
// cells, not their source: this is what gives real discourse flow — connectives
// and participant reference that follow what was actually said in the target
// language. v1 measures the budget in CELL COUNT (not tokens) to avoid a tokenizer
// dependency; a token budget is a later refinement.
// See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D4, D10).

export interface DraftContextSettings {
  /** How many preceding committed-target cells (same file, document order) to
   *  include as left-context. v1 unit is cell count; token budget is deferred. */
  precedingTargetCells: number
}

export const DEFAULT_DRAFT_CONTEXT: DraftContextSettings = {
  precedingTargetCells: 3,
}

type MinimalCell = { id: string; fileId: string; original: string; translated: string }

/**
 * Collect the committed target of up to `count` cells immediately preceding
 * `cellId` within the SAME file, in document order. Cells with an empty target
 * are skipped (nothing to learn from). `cells` is assumed to be in document order
 * (the order useCells/useProject already returns rows in).
 */
export function gatherPrecedingContext(
  cells: MinimalCell[],
  cellId: string,
  count: number,
): { source: string; target: string }[] {
  if (count <= 0) return []
  const idx = cells.findIndex((c) => c.id === cellId)
  if (idx === -1) return []
  const fileId = cells[idx].fileId

  const out: { source: string; target: string }[] = []
  for (let i = idx - 1; i >= 0 && out.length < count; i--) {
    const c = cells[i]
    if (c.fileId !== fileId) break // do not cross a file boundary
    if (!c.original.trim() || !c.translated.trim()) continue
    out.push({ source: c.original, target: c.translated })
  }
  return out.reverse() // restore document order (oldest → newest)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/completion/__tests__/draft-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/completion/draft-context.ts src/lib/completion/__tests__/draft-context.test.ts
git commit -m "feat(completion): gather preceding committed-target discourse context

Left-context = committed target of preceding same-file cells in document order (D4).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `draftContext` project setting

**Files:**
- Modify: `src/lib/sync/project-settings.ts:57-72` (add a field inside `ProjectWideSettings`, after `translationBrief`)

**Interfaces:**
- Consumes: `DraftContextSettings` from Task 2 (`src/lib/completion/draft-context.ts`).
- Produces: optional `draftContext?: DraftContextSettings` on `ProjectWideSettings`.

- [ ] **Step 1: Add the import and field**

Add the import near the other type imports at the top of the file (after the `TranslationBrief` import on line 11):

```typescript
import type { DraftContextSettings } from "@/lib/completion/draft-context"
```

Add this field inside the `ProjectWideSettings` interface, immediately after the `translationBrief?: TranslationBrief` block (currently ending line 57):

```typescript
  /**
   * AI-draft context budget (Phase 0). Currently just how many preceding
   * committed-target cells to feed the draft as discourse left-context. Synced
   * like other top-level keys; absent → DEFAULT_DRAFT_CONTEXT applies.
   * See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D10).
   */
  draftContext?: DraftContextSettings
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc -b`
Expected: no new errors (a `draftContext` key is now accepted on the settings blob).

- [ ] **Step 3: Commit**

```bash
git add src/lib/sync/project-settings.ts
git commit -m "feat(settings): add draftContext to ProjectWideSettings (D10)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `buildPrompt` renders preceding context

**Files:**
- Modify: `src/lib/completion/completion-service.ts:146-198` (`buildPrompt`)
- Test: add to the existing completion-service test file (find it: `git ls-files | grep completion-service` — likely `src/lib/completion/__tests__/completion-service.test.ts`).

**Interfaces:**
- Consumes: nothing new (plain `{ source, target }[]`).
- Produces: a new optional `precedingContext?: { source: string; target: string }[]` on `buildPrompt`'s options; rendered after few-shot examples and immediately before the live source.

- [ ] **Step 1: Write the failing test**

Add to the completion-service test file:

```typescript
import { buildPrompt } from "../completion-service" // adjust if already imported

describe("buildPrompt precedingContext (D4)", () => {
  it("renders preceding committed context after examples and just before the live source", () => {
    const [, user] = buildPrompt({
      sourceLanguage: "Greek", targetLanguage: "Kala", systemPrompt: "X",
      sourceText: "LIVE_SRC",
      examples: [{ source: "EX_SRC", target: "EX_TGT" }],
      precedingContext: [{ source: "PREV_SRC", target: "PREV_TGT" }],
    })
    const c = user.content
    // example comes before preceding-context, which comes before the live source
    expect(c.indexOf("EX_SRC")).toBeLessThan(c.indexOf("PREV_SRC"))
    expect(c.indexOf("PREV_SRC")).toBeLessThan(c.indexOf("LIVE_SRC"))
    expect(c).toContain("PREV_TGT")
    expect(c.trimEnd().endsWith("LIVE_SRC\nTranslation:")).toBe(true)
  })

  it("omits empty/blank preceding pairs and works when absent", () => {
    const [, user] = buildPrompt({
      sourceLanguage: "Greek", targetLanguage: "Kala", systemPrompt: "X",
      sourceText: "LIVE", examples: [],
      precedingContext: [{ source: "S", target: "  " }],
    })
    expect(user.content).not.toContain("\nTranslation:   \n")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run <completion-service test path> -t "precedingContext"`
Expected: FAIL — `precedingContext` not rendered (PREV_SRC absent).

- [ ] **Step 3: Implement**

In `buildPrompt`'s options type (around line 156, after `briefSummary?: string`), add:

```typescript
  /** Committed target of the immediately preceding cells (document order) — the
   *  discourse window. Rendered last (closest to the live source) because it is
   *  real continuity, not a retrieved example. Left-context is the TARGET, not the
   *  source: it is what gives connectives and participant reference real flow. (D4) */
  precedingContext?: { source: string; target: string }[]
```

Then replace the final user-message assembly (currently line 195, `user += \`Source: ${options.sourceText}\nTranslation:\``) with:

```typescript
  // Immediately-preceding committed context (discourse window): render after the
  // few-shot examples and just before the live source so it sits closest to what
  // the model is about to translate. Skip blank pairs. (D4)
  for (const ctx of options.precedingContext ?? []) {
    if (ctx.source.trim() && ctx.target.trim()) {
      user += `Source: ${ctx.source}\nTranslation: ${ctx.target}\n\n`
    }
  }
  user += `Source: ${options.sourceText}\nTranslation:`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run <completion-service test path>`
Expected: PASS (new cases + existing buildPrompt tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/completion/completion-service.ts <completion-service test path>
git commit -m "feat(completion): buildPrompt renders preceding committed context (D4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire it into `completeSingle`

**Files:**
- Modify: `src/hooks/useCompletion.ts:132-205` (`completeSingle`) and the hook signature (~line 96 where `allCells` is received)
- Modify: `src/components/ProjectWorkspace.tsx:1336-1338` (the `useCompletion(...)` call)

**Interfaces:**
- Consumes: `compressExampleSource`, `dedupeExamples` (Task 1); `gatherPrecedingContext`, `DEFAULT_DRAFT_CONTEXT`, `DraftContextSettings` (Task 2); `buildPrompt.precedingContext` (Task 4); `project.draftContext` (Task 3).
- Produces: a `completeSingle` whose prompt includes compressed+deduped examples and preceding committed-target context.

- [ ] **Step 1: Add imports to `useCompletion.ts`**

```typescript
import { compressExampleSource, dedupeExamples } from "@/lib/completion/compress-examples"
import { gatherPrecedingContext, DEFAULT_DRAFT_CONTEXT, type DraftContextSettings } from "@/lib/completion/draft-context"
```

- [ ] **Step 2: Thread `draftContext` into the hook**

Add a `draftContext` parameter to the `useCompletion` signature (default to `DEFAULT_DRAFT_CONTEXT`) alongside the existing params (the hook already receives `allCells`, `rules`, `briefSummary`). Use the exact param list the file already has; append:

```typescript
  draftContext: DraftContextSettings = DEFAULT_DRAFT_CONTEXT,
```

- [ ] **Step 3: Transform examples + gather context in `completeSingle`**

In `completeSingle`, after `found` is obtained from `search(...)` and before `buildPrompt(...)` (around lines 143–159), insert:

```typescript
  // Compress the retrieved examples (deterministic source-span truncation using the
  // matched-token provenance the search already returns) and drop near-duplicates,
  // so the freed budget can hold the discourse window below. (D6)
  const compressedExamples = dedupeExamples(
    found.map((e) => ({
      source: compressExampleSource(e.source, { matchedTokens: e.matchedTokens }),
      target: e.target,
    })),
  )

  // Left-context = committed target of the preceding cells (D4).
  const precedingContext = gatherPrecedingContext(
    allCells ?? [],
    cell.id,
    draftContext.precedingTargetCells,
  )
```

Then change the `buildPrompt({...})` call's `examples` to `compressedExamples` and add `precedingContext`:

```typescript
    examples: compressedExamples,
    // ...existing fields (rules, validatedPairs, exampleFormat, briefSummary)...
    precedingContext,
```

> NOTE for implementer: confirm the `ScoredPair` type returned by `search` exposes `matchedTokens?: string[]` (it does — see `ProjectWorkspace.tsx` branching-search mapping, `matchedTokens: res.provenance[cellId]`). If a given search path omits it, `compressExampleSource` degrades gracefully (head+ellipsis).

- [ ] **Step 4: Pass `draftContext` from `ProjectWorkspace.tsx`**

In the `useCompletion(...)` call (lines 1336–1338), append the project's setting with a default:

```typescript
    project?.draftContext ?? DEFAULT_DRAFT_CONTEXT,
```

Add the import at the top of `ProjectWorkspace.tsx`:

```typescript
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"
```

- [ ] **Step 5: Type-check and run the completion test suite**

Run: `pnpm tsc -b && pnpm vitest run src/lib/completion src/hooks`
Expected: PASS, no new type errors.

- [ ] **Step 6: Verify in the running app**

Use the `verify-dev-change` skill (or the dev stack): open a project with at least one file that has several committed (validated/translated) cells in a row, click the sparkle on an *empty* cell that follows them, and confirm via the network panel that the outgoing `/chat/completions` request body's user message contains the preceding cells' **target** text right before the final `Source: …\nTranslation:`. This is the observable proof of D4. (Streaming is disabled for the default Frontier provider; the request body is still inspectable.)

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useCompletion.ts src/components/ProjectWorkspace.tsx
git commit -m "feat(completion): feed preceding target + compressed examples to single-cell draft

Wires D4 (discourse left-context) and D6 (example compression) into completeSingle;
context budget from project draftContext setting (D10).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** D4 → Tasks 2,4,5; D6 → Tasks 1,5; D10 → Tasks 2,3,5. D5 (source-side retrieval) pre-existing (branching-search) — noted, no task. D7 (terminology elision) and D8-in-anger, plus D1/D2/D3/D9/D11 → Phase 1+, explicitly out of scope.
- **Placeholder scan:** none — every code step carries full code; the one lookup (test-file path) has a `git ls-files` command to resolve it.
- **Type consistency:** `DraftContextSettings`/`DEFAULT_DRAFT_CONTEXT` defined in Task 2, consumed by Tasks 3 & 5; `precedingContext` shape `{source,target}[]` consistent across Tasks 4 & 5; `compressExampleSource`/`dedupeExamples` signatures consistent across Tasks 1 & 5.

## Out of scope (Phase 1+, see spec)

Paragraph grouping + corpus-branched splitter (D1/D2), `completeParagraph` unit + `<vN>` output protocol (D3/D11), terminology elision (D7), embeddings, cast legend (D9), settings UI for `draftContext`, token-based budgets.
