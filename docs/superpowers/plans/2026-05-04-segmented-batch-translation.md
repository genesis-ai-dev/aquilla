# Segmented Batch Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate a user-selected batch of cells as a single segmented LLM call (with `<vN>...</vN>` framing) instead of N independent calls. Retrieve few-shot examples once over the concatenated batch source, then expand each hit with its file-order neighbors so examples are mini-passages, not isolated cells. Demux the streamed response back into individual cells; fall back to per-cell completion only for cells whose tag was missing or malformed.

**Why:** LLMs translate a passage substantially better than the same verses in isolation — they get pronoun antecedents, tense agreement, and discourse cohesion that a single-cell prompt cannot supply. The current `completeBatch` in `useCompletion.ts` is N parallel single-cell calls, which gives up that signal.

**Architecture:** The change is contained to the completion path. A new `buildBatchPrompt` in `src/lib/completion/completion-service.ts` produces a `<vN>`-framed prompt; a new `parseSegmentedResponse` (incremental, stream-friendly) demuxes response chunks back to cell ids. A new `expandWithNeighbors` helper in `src/lib/search/` takes the existing branching-search results and pulls ±2 contiguous cells from each hit's `fileId` using project order. `useCompletion.completeBatch` is rewritten to chunk by a cell-count cap, run sub-batches sequentially (so each can include the prior batch's translations as additional few-shot continuity), stream `<vN>` blocks into each cell's `translatedXml` as they close, and fall back to `completeSingle` for any cells that didn't round-trip. No schema changes.

**Tech Stack:** TypeScript, React, Vitest, Yjs, existing `complete()` service, existing `DualIndex`.

**Spec:** none — design is captured in this plan.

---

## Locked design decisions

These were settled in conversation with the user; do not relitigate during implementation:

- **Batch is user-selected.** `completeBatch(cells: CellData[])` keeps its signature; selection UI is out of scope. Auto-batching is a later project.
- **Cap is by cell count, not token math.** Default `MAX_CELLS_PER_CALL = 30`. Over-cap selections are split into sequential sub-batches; each sub-batch's prompt appends the previous sub-batch's just-translated cells as extra few-shot examples.
- **Delimiter format is `<v1>...</v1><v2>...</v2>`**, numbered and mirrored on both source and translation sides of the prompt. Numbered (not bare `<v>`) so missing/extra tags are recoverable.
- **Retrieval is one branching search over the concatenated batch source**, then ±2 file-order neighbor expansion per hit. `limit` drops from 5 to 3 hits since each hit is now a mini-passage.
- **Streaming UX:** parse closed `<vN>...</vN>` blocks off the partial buffer as they arrive and route into each cell's `translatedXml` via `setPlainText`. Cells stay in the `generating` state until their tag closes.
- **Mismatch fallback is per-cell, not per-batch.** Any cell whose tag is missing/malformed in the response is retried via the existing single-cell path. The batch as a whole does not fail.
- **Format spec lives in code, not in the user-editable system prompt.** `buildBatchPrompt` hardcodes the `<vN>` framing and prepends framing instructions to whatever system prompt the project has configured. Future projects can override per-project if the need arises.

---

## Task 1: `buildBatchPrompt` (TDD)

**Files:**
- Modify: `src/lib/completion/completion-service.ts`
- Modify: `src/lib/completion/completion-service.test.ts`

- [ ] **Step 1: Write failing tests for `buildBatchPrompt`**

Add a `describe("buildBatchPrompt", ...)` block covering:
1. Numbered tags: source side renders `<v1>...</v1><v2>...</v2>` with the cell originals, asks the model to produce the same structure on the translation side.
2. Examples: each example is rendered with mirrored `<vN>` tags too, so the model sees the format demonstrated.
3. Continuity injection: an optional `priorBatch: { source: string; target: string }[]` argument is rendered as the last example before the live segment (used for sub-batch chaining).
4. System prompt: framing instructions are prepended to the user-supplied system prompt; `{sourceLanguage}` / `{targetLanguage}` substitution still works.

- [ ] **Step 2: Implement `buildBatchPrompt`**

Add (do not modify `buildPrompt`):

```ts
export function buildBatchPrompt(options: {
  sourceLanguage: string
  targetLanguage: string
  systemPrompt: string
  cells: { id: string; source: string }[]
  examples: { sources: string[]; targets: string[] }[]   // each example is a passage
  priorBatch?: { source: string; target: string }[]      // sub-batch continuity tail
}): ChatMessage[]
```

Format details:
- Wrap each cell as `<v1>source</v1>` joined by `\n` for readability. Numbering is 1-based and resets per call.
- Examples: render `Source:\n<v1>..</v1>\n<v2>..</v2>\n\nTranslation:\n<v1>..</v1>\n<v2>..</v2>` so the model sees mirrored framing in-context.
- Trailing prompt ends with `Source:\n<v1>..</v1>...<vN>..</vN>\n\nTranslation:\n` (no opening `<v1>` — let the model produce it, mirroring single-cell behavior).
- Framing instructions prepended to `systemPrompt`: "The source is segmented with `<v1>`, `<v2>`, ... tags. Produce a translation segmented with the same tags, in the same order, with the same count. Do not merge, split, omit, or reorder segments."

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm test src/lib/completion/completion-service.test.ts
npx tsc -p tsconfig.app.json --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/completion/completion-service.ts src/lib/completion/completion-service.test.ts
git commit -m "feat(completion): add buildBatchPrompt with <vN> segmented framing"
```

---

## Task 2: Incremental segmented-response parser (TDD)

**Files:**
- Create: `src/lib/completion/segmented-parser.ts`
- Create: `src/lib/completion/segmented-parser.test.ts`

- [ ] **Step 1: Write failing tests**

Cover (use `expect.poll` or just feed strings synchronously):
1. Single full block: feed `"<v1>hello</v1>"`, parser yields `{ index: 1, text: "hello" }` once.
2. Split across feeds: `"<v1>hel"`, then `"lo</v1><v2>"`, then `"world</v2>"` yields v1 then v2.
3. Stray text between blocks is ignored.
4. Out-of-order or skipped indices: `<v3>` arriving before `<v2>` is reported with its actual index — caller decides what to do.
5. Final flush: incomplete trailing block (`<v3>partial`) at end-of-stream is reported as `{ index: 3, text: "partial", incomplete: true }` so callers can choose to keep or discard.
6. Malformed: `<v1>foo<v2>bar</v2>` (missing `</v1>`) reports v2 successfully and v1 as incomplete on flush.

- [ ] **Step 2: Implement parser**

```ts
export interface SegmentedChunk {
  index: number
  text: string
  incomplete?: boolean
}
export class SegmentedParser {
  feed(chunk: string): SegmentedChunk[]
  flush(): SegmentedChunk[]
}
```

Implementation: regex-driven state machine that scans for `<v(\d+)>` and the matching `</v\1>` closing tag, buffers everything in between, and emits on close. Any text before the first `<vN>` or between blocks is dropped. Be generous with whitespace — strip leading/trailing whitespace from emitted text but preserve internal whitespace.

- [ ] **Step 3: Run tests**

```bash
pnpm test src/lib/completion/segmented-parser.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/completion/segmented-parser.ts src/lib/completion/segmented-parser.test.ts
git commit -m "feat(completion): add SegmentedParser for streamed <vN> responses"
```

---

## Task 3: Neighbor-expanded retrieval (TDD)

**Files:**
- Create: `src/lib/search/expand-neighbors.ts`
- Create: `src/lib/search/expand-neighbors.test.ts`

- [ ] **Step 1: Write failing tests**

The helper takes branching-search hits and project file order, and returns passage examples:

```ts
export interface PassageExample {
  fileId: string
  cells: { cellId: string; source: string; target: string }[]
}
expandWithNeighbors(
  hits: ScoredPair[],
  fileOrder: Map<string, string[]>,           // fileId -> ordered cellIds
  cellLookup: Map<string, { source: string; target: string }>,
  radius: number,
): PassageExample[]
```

Test cases:
1. Hit at index 5 with radius 2 returns cells [3..7] in order (only those that exist in lookup with non-empty source+target).
2. Edge of file: hit at index 0 returns [0..2] (no negative wrap).
3. Two hits in the same file with overlapping windows produce a single merged passage, not two with duplicates.
4. Cells without target translations are skipped — neighbors are filled-only.
5. Output preserves file order.

- [ ] **Step 2: Implement `expandWithNeighbors`**

Straightforward: per fileId, sort the hit indices, walk outward by `radius`, merge overlapping windows, filter out empty-target cells via `cellLookup`.

- [ ] **Step 3: Wire into `useSearchIndex`**

Extend `useSearchIndex` to also expose:
```ts
searchPassages(query: string, hits?: number, radius?: number): PassageExample[]
```
which calls `searchBranchingSource` + `expandWithNeighbors`. The existing `search` callback stays as-is for single-cell completion.

The hook needs file-order info; build `fileOrder: Map<fileId, cellId[]>` and `cellLookup` from `allProjectCells` in the same `useEffect` that builds the index.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm test src/lib/search/expand-neighbors.test.ts
npx tsc -p tsconfig.app.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/expand-neighbors.ts src/lib/search/expand-neighbors.test.ts src/hooks/useSearchIndex.ts
git commit -m "feat(search): expand search hits to file-order neighbor passages"
```

---

## Task 4: Rewrite `completeBatch` to use segmented calls

**Files:**
- Modify: `src/hooks/useCompletion.ts`
- Modify: `src/components/ProjectWorkspace.tsx` (only if hook signature changes)

- [ ] **Step 1: Adjust hook signature**

`useCompletion` currently receives `search`. Change to also accept `searchPassages` (the neighbor-expanded variant). Single-cell `completeSingle` continues to use `search`; `completeBatch` uses `searchPassages`. Update the `ProjectWorkspace` call site to pass both from `useSearchIndex`.

- [ ] **Step 2: Implement segmented `completeBatch`**

Replace the current parallel-3 worker-pool body with:

```
const MAX_CELLS_PER_CALL = 30

// 1. Chunk cells by cap, preserving user-selected order
const chunks: CellData[][] = chunkBy(cells, MAX_CELLS_PER_CALL)

// 2. Sequential sub-batches
let priorBatch: { source: string; target: string }[] = []
for (const chunk of chunks) {
  // a. mark all cells "searching"
  // b. retrieve passages with searchPassages(concatenatedSource, 3, 2)
  // c. mark all cells "generating"
  // d. build prompt with buildBatchPrompt(..., priorBatch, examples)
  // e. complete() with stream:true and a SegmentedParser-driven onChunk:
  //      for each emitted SegmentedChunk { index, text }:
  //        cell = chunk[index - 1]
  //        if (cell) write text into cell's translatedXml via setPlainText
  // f. on stream end: flush parser; for any cell that never got a non-incomplete
  //    chunk, push its id into a `failed` list
  // g. for cells that succeeded, appendCellHistory with source:"llm" and the
  //    passage examples that drove this sub-batch (flatten to {cellId, weight:1})
  // h. priorBatch = chunk's just-translated {source,target} pairs (for next chunk's continuity)
  // i. for `failed` cells, call completeSingle(cell) inline
}
```

Notes:
- Keep the existing `setCompleting` / `setExamples` / `setErrors` state shape so consumers (`EditorTable`, `ExamplePanel`) keep working. `examples` map gets the same `ScoredPair[]` for every cell in a sub-batch — fine, they share examples.
- The parser's `onChunk` runs inside `complete({ onChunk })`. Build the parser per sub-batch, feed it the streamed text, write completed blocks to Yjs in a `doc.transact`.
- If `complete()` errors mid-stream, mark every still-generating cell in the chunk as `error` with the error message, and do not advance to the next chunk.

- [ ] **Step 3: Posthog event update**

The existing `ai batch translation started` capture at `useCompletion.ts:110` keeps firing once per `completeBatch` call. Add `chunk_count` and `max_cells_per_call` to its properties. Replace per-cell `ai translation completed` for batch-success cells with a single `ai batch translation completed` per sub-batch carrying `cell_count`, `example_count`, `fallback_count` (cells that fell through to single-cell).

- [ ] **Step 4: Manual smoke test**

`pnpm dev`, open a project with translated cells, select 5 cells with `original` set and `translated` empty, hit batch-translate. Verify:
- Network panel shows one `/chat/completions` call (or two if your selection has overlapping `<v>` examples — fine).
- Each cell streams content as its `</vN>` closes.
- If you mid-stream-kill the network, every still-generating cell shows the error message.
- Selecting >30 cells fires sequentially; the second sub-batch's request body contains the first batch's source/target as the last example.

- [ ] **Step 5: Run lint + tests + typecheck**

```bash
pnpm lint
pnpm test
npx tsc -p tsconfig.app.json --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useCompletion.ts src/hooks/useSearchIndex.ts src/components/ProjectWorkspace.tsx
git commit -m "feat(completion): segmented batch translation with neighbor-expanded examples"
```

---

## Task 5: Hook integration tests

**Files:**
- Create: `src/hooks/useCompletion.batch.test.ts` (or extend existing test if one exists)

- [ ] **Step 1: Write tests against a mocked completion service**

Mock `complete` to return scripted streams via `onChunk`. Cover:
1. Happy path: 3 cells → 1 call → all 3 receive their `<vN>` text.
2. Partial response: stream contains `<v1>`, `<v3>` but skips `<v2>` → cells 1 and 3 get content, cell 2 falls through to a second `complete` call (single-cell).
3. Cap split: 35 cells → 2 sub-batches of 30 + 5; verify the second call's prompt body contains some of batch-1's outputs as continuity examples.
4. Stream error: `complete` rejects mid-way → all still-generating cells in that sub-batch land in `error` state; later sub-batches do not run.
5. Empty translatedXml on cells before the call (precondition); after, every successful cell has expected text.

Use the existing `fake-indexeddb`/`happy-dom` setup; build a tiny in-memory `Y.Doc` with cells per the test plan. Re-use patterns from existing hook tests if there are any (`grep -l "useCompletion" src/hooks/`).

- [ ] **Step 2: Run tests**

```bash
pnpm test src/hooks/useCompletion.batch.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useCompletion.batch.test.ts
git commit -m "test(completion): integration tests for segmented batch translation"
```

---

## Out of scope (explicitly)

- Auto-determining "good" batches from a passage / chapter boundary — the user picks the batch.
- Token-budget-driven chunking — cell-count cap is the v1 mechanism. Revisit if real selections start blowing past model context.
- User-editable delimiter format — `<vN>` is hardcoded for now.
- Backtranslation segmentation — same idea would apply but is a separate change.
- UI affordance to *show* which examples drove a batch (currently per-cell `examples` map already populates; no new UI needed).

---

## Success criteria

- A user can select N cells and click batch-translate; for N ≤ 30, exactly one `/chat/completions` request is made.
- Each cell receives its translation incrementally as its `</vN>` tag closes, not all at once at the end.
- A scripted response with a missing `<v2>` results in cell 2 being retried via the single-cell path, not the whole batch failing.
- For N > 30, sub-batches run sequentially and the second sub-batch's prompt demonstrably includes batch-1 outputs as few-shot continuity.
- Existing single-cell completion (`completeSingle`) is unchanged in behavior and still passes its existing tests.
