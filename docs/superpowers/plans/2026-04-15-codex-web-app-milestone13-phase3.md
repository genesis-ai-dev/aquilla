# M13 Phase 3 — Lossless Two-Way Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a lossless, CRDT-style two-way merge so that the `remote-moved` case from Phase 2 becomes a real merge+push instead of an error.

**Architecture:** We never invoke `git.merge`. We compute a tree diff via `git.walk` between `oursSha` and `theirsSha`, run per-path pure resolvers over the conflicting blobs (union of `metadata.edits[]` ledgers for `.codex`/`.source`, thread-aware merge for comments, etc.), build a merged tree with `git.writeBlob` + `git.writeTree`, commit with two parents, push, and rehydrate the touched `FileDocHandle`s from the merged bytes inside a single `doc.transact()`.

**Tech Stack:** TypeScript, isomorphic-git, Yjs + y-indexeddb, Vitest, OPFS.

**Spec:** `docs/superpowers/specs/2026-04-15-codex-web-app-milestone13-phase3-git-merge-design.md`

**Predecessor code to reuse:**
- `src/lib/codex-editor/merge/cells.ts` — `mergeTwoCellsUsingResolverLogic`, `applyEditToCell` (Phase 2 vendored)
- `src/lib/codex-editor/merge/validators.ts` — `mergeValidatedByLists`, `isValidValidationEntry`
- `src/lib/codex-editor/merge/comments.ts` — `generateCommentId`, `areCommentsDuplicate`, `migrateComment`
- `src/lib/codex-editor/parse-codex.ts` — `parseCodexNotebook(raw: string): CodexNotebookFile`
- `src/lib/codex-editor/serialize/file.ts` — `serializeFile(doc: Y.Doc): CodexNotebookFile`

**Reference implementation:** `/Users/ryderwishart/frontierrnd/codex-editor/src/projectManager/utils/merge/resolvers.ts` (browser-incompatible — we port, not import)

---

## File structure

**New files**
```
src/lib/codex-editor/merge/
  strategies.ts                 # Path → strategy routing
  resolvers.ts                  # Top-level two-way dispatcher
  resolveCodex.ts               # .codex / .source two-way merge
  resolveComments.ts            # comments.json two-way merge
  resolveMetadata.ts            # metadata.json two-way merge
  resolveJsonMerge.ts           # .json fallback deep merge
  __test__/
    strategies.test.ts
    resolveCodex.test.ts
    resolveComments.test.ts
    resolveMetadata.test.ts
    resolveJsonMerge.test.ts
    resolvers.test.ts

src/lib/sync/git-merge/
  index.ts                      # mergeRemoteIntoOurs orchestrator
  tree-diff.ts                  # buildTreeDiff via git.walk
  tree-write.ts                 # buildTreeFromOursPlusOverrides
  __test__/
    tree-diff.test.ts
    tree-write.test.ts
    git-merge.test.ts
    git-merge.integration.test.ts
```

**Modified files**
```
src/lib/codex-editor/types.ts          # Extend CodexNotebookMetadata.edits?: EditHistory[]
src/lib/codex-editor/merge/index.ts    # Re-export new resolvers
src/lib/sync/git-sync.ts               # Remove remote-moved early return; branch into merge
src/lib/store/file-doc.ts              # Add rehydrateFileDoc
src/hooks/useSyncProject.ts            # Expose syncing flag
src/components/SyncButton.tsx          # Update label + behaviour for remote-moved
src/context/SyncingContext.tsx         # NEW — lightweight context so cells know to freeze
src/components/editor/CodexCellEditor.tsx  # Consume SyncingContext, short-circuit onChange
```

---

## Task 1: Strategy routing

**Files:**
- Create: `src/lib/codex-editor/merge/strategies.ts`
- Test: `src/lib/codex-editor/merge/__test__/strategies.test.ts`

- [ ] **Step 1.1: Write the failing test**

```ts
// src/lib/codex-editor/merge/__test__/strategies.test.ts
import { describe, it, expect } from "vitest"
import { Strategy, determineStrategy } from "../strategies"

describe("determineStrategy", () => {
  it("routes .codex files to CODEX", () => {
    expect(determineStrategy("files/target/gen.codex")).toBe(Strategy.CODEX)
    expect(determineStrategy("/files/target/gen.codex")).toBe(Strategy.CODEX)
  })

  it("routes .source files to CODEX", () => {
    expect(determineStrategy(".project/sourceTexts/gen.source")).toBe(Strategy.CODEX)
  })

  it("routes comments.json to COMMENTS", () => {
    expect(determineStrategy(".project/comments.json")).toBe(Strategy.COMMENTS)
  })

  it("routes metadata.json to METADATA", () => {
    expect(determineStrategy("metadata.json")).toBe(Strategy.METADATA)
    expect(determineStrategy("/metadata.json")).toBe(Strategy.METADATA)
  })

  it("routes .vscode/settings.json to JSON_MERGE", () => {
    expect(determineStrategy(".vscode/settings.json")).toBe(Strategy.JSON_MERGE)
  })

  it("routes complete_drafts.txt to IGNORE", () => {
    expect(determineStrategy("complete_drafts.txt")).toBe(Strategy.IGNORE)
  })

  it("falls back to JSON_MERGE for unknown .json", () => {
    expect(determineStrategy("foo/bar.json")).toBe(Strategy.JSON_MERGE)
  })

  it("falls back to OVERRIDE for unknown non-json", () => {
    expect(determineStrategy("files/media/clip.mp4")).toBe(Strategy.OVERRIDE)
  })

  it("normalizes backslash path separators", () => {
    expect(determineStrategy("files\\target\\gen.codex")).toBe(Strategy.CODEX)
  })
})
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/strategies.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement strategies.ts**

```ts
// src/lib/codex-editor/merge/strategies.ts
// Ported from codex-editor/src/projectManager/utils/merge/strategies.ts,
// minus the SPECIAL strategy (unused) and ARRAY (we collapse into COMMENTS).

export enum Strategy {
  CODEX = "codex",
  COMMENTS = "comments",
  METADATA = "metadata",
  JSON_MERGE = "json-merge",
  IGNORE = "ignore",
  OVERRIDE = "override",
}

export const filePatternsToResolve: Record<Strategy, string[]> = {
  [Strategy.CODEX]: ["files/target/*.codex", ".project/sourceTexts/*.source"],
  [Strategy.COMMENTS]: [".project/comments.json"],
  [Strategy.METADATA]: ["metadata.json"],
  [Strategy.JSON_MERGE]: [".vscode/settings.json"],
  [Strategy.IGNORE]: ["complete_drafts.txt"],
  [Strategy.OVERRIDE]: [],
}

export function determineStrategy(filePath: string): Strategy {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\//, "")

  for (const [strategy, patterns] of Object.entries(filePatternsToResolve) as
      Array<[Strategy, string[]]>) {
    for (const pattern of patterns) {
      if (strategy === Strategy.IGNORE) {
        if (normalized === pattern || normalized.endsWith("/" + pattern)) return strategy
        continue
      }
      if (pattern.includes("*")) {
        const regex = new RegExp(pattern.replace(/\./g, "\\.").replace("*", ".*"))
        if (regex.test(normalized)) return strategy
      } else if (normalized === pattern || normalized.endsWith("/" + pattern)) {
        return strategy
      }
    }
  }

  return normalized.endsWith(".json") ? Strategy.JSON_MERGE : Strategy.OVERRIDE
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/strategies.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/codex-editor/merge/strategies.ts src/lib/codex-editor/merge/__test__/strategies.test.ts
git commit -m "feat(m13.3): path→strategy routing for two-way merge resolvers"
```

---

## Task 2: Resolve `.codex` / `.source` two-way

This is the biggest resolver. It owns cell-by-cell merge, file-level `metadata.edits[]` union, and theirs-only cell position preservation.

**Files:**
- Create: `src/lib/codex-editor/merge/resolveCodex.ts`
- Test: `src/lib/codex-editor/merge/__test__/resolveCodex.test.ts`
- Modify: `src/lib/codex-editor/types.ts` (add `edits` to `CodexNotebookMetadata`)
- Modify: `src/lib/codex-editor/merge/index.ts` (re-export)

- [ ] **Step 2.1: Extend the `CodexNotebookMetadata` type**

Edit `src/lib/codex-editor/types.ts` — add the `edits` field to `CodexNotebookMetadata`:

```ts
// src/lib/codex-editor/types.ts, after line 78
export interface CodexNotebookMetadata {
  id: string;
  originalName: string;
  corpusMarker?: string;
  textDirection?: "ltr" | "rtl";
  videoUrl?: string;
  sourceCreatedAt?: string;
  codexLastModified?: string;
  navigation?: unknown[];
  edits?: EditHistory[];    // NEW — file-level edit ledger, same shape as cell edits
  [key: string]: unknown;
}
```

- [ ] **Step 2.2: Write the failing test**

```ts
// src/lib/codex-editor/merge/__test__/resolveCodex.test.ts
import { describe, it, expect } from "vitest"
import { resolveCodexTwoWay } from "../resolveCodex"
import type { CodexCell, CodexNotebookFile, EditHistory } from "@/lib/codex-editor/types"

function cell(id: string, value: string, edits: EditHistory[] = []): CodexCell {
  return {
    kind: 2,
    languageId: "html",
    value,
    metadata: { id, type: "text", edits },
  }
}

function nb(cells: CodexCell[], meta: Partial<CodexNotebookFile["metadata"]> = {}): string {
  return JSON.stringify({
    cells,
    metadata: { id: "f1", originalName: "gen", ...meta },
  })
}

const edit = (path: string[], value: unknown, ts: number, author = "a"): EditHistory => ({
  editMap: path, value, timestamp: ts, author, type: "user-edit",
})

describe("resolveCodexTwoWay", () => {
  it("returns theirs when ours is empty", async () => {
    const out = await resolveCodexTwoWay("", nb([cell("c1", "hi")]))
    expect(JSON.parse(out).cells[0].metadata.id).toBe("c1")
  })

  it("returns ours when theirs is empty", async () => {
    const out = await resolveCodexTwoWay(nb([cell("c1", "hi")]), "")
    expect(JSON.parse(out).cells[0].metadata.id).toBe("c1")
  })

  it("unions disjoint cell edits", async () => {
    const ours = nb([cell("c1", "A", [edit(["value"], "A", 10)])])
    const theirs = nb([cell("c1", "B", [edit(["value"], "B", 20)])])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    const edits = merged.cells[0].metadata.edits as EditHistory[]
    expect(edits.map(e => e.value).sort()).toEqual(["A", "B"])
    expect(merged.cells[0].value).toBe("B") // latest timestamp wins
  })

  it("dedupes identical edits by (timestamp, editMap, value)", async () => {
    const e = edit(["value"], "same", 15)
    const ours = nb([cell("c1", "same", [e])])
    const theirs = nb([cell("c1", "same", [e])])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells[0].metadata.edits).toHaveLength(1)
  })

  it("keeps ours-only cells", async () => {
    const ours = nb([cell("c1", "A"), cell("c2", "mine")])
    const theirs = nb([cell("c1", "A")])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells.map((c: CodexCell) => c.metadata.id)).toEqual(["c1", "c2"])
  })

  it("inserts theirs-only cells at position preserving neighbor order", async () => {
    const ours = nb([cell("c1", "A"), cell("c3", "C")])
    const theirs = nb([cell("c1", "A"), cell("c2", "B"), cell("c3", "C")])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells.map((c: CodexCell) => c.metadata.id)).toEqual(["c1", "c2", "c3"])
  })

  it("appends theirs-only cells when anchor missing", async () => {
    const ours = nb([cell("c1", "A")])
    const theirs = nb([cell("c99", "new")])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells.map((c: CodexCell) => c.metadata.id)).toEqual(["c1", "c99"])
  })

  it("keeps both-sides-soft-deleted cell (audit)", async () => {
    const deletedMark = edit(["metadata", "data", "deleted"], true, 30)
    const ours = nb([cell("c1", "", [deletedMark])])
    const theirs = nb([cell("c1", "", [deletedMark])])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells).toHaveLength(1)
    expect(merged.cells[0].metadata.id).toBe("c1")
  })

  it("unions file-level metadata.edits", async () => {
    const ours = nb([cell("c1", "A")], { edits: [edit(["videoUrl"], "u1", 5)] })
    const theirs = nb([cell("c1", "A")], { edits: [edit(["videoUrl"], "u2", 10)] })
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.metadata.edits).toHaveLength(2)
  })

  it("filters invalid validatedBy entries", async () => {
    const eRaw = edit(["value"], "x", 1)
    ;(eRaw as unknown as { validatedBy: unknown[] }).validatedBy = [
      { notAValidationEntry: true },
      { username: "u", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: false },
    ]
    const ours = nb([cell("c1", "x", [eRaw])])
    const theirs = nb([cell("c1", "x")])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells[0].metadata.edits[0].validatedBy).toHaveLength(1)
  })
})
```

- [ ] **Step 2.3: Run test to verify it fails**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/resolveCodex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2.4: Implement `resolveCodex.ts`**

```ts
// src/lib/codex-editor/merge/resolveCodex.ts
// Two-way merge for .codex / .source notebook files.
// Ported from codex-editor/src/projectManager/utils/merge/resolvers.ts:1108-1272
// minus the three-way/base parameter (we union edit ledgers; union is total).

import type {
  CodexCell, CodexNotebookFile, CodexNotebookMetadata, EditHistory,
} from "@/lib/codex-editor/types"
import { mergeTwoCellsUsingResolverLogic } from "./cells"
import { isValidValidationEntry } from "./validators"

function editKey(e: EditHistory): string {
  return `${e.timestamp}:${e.editMap.join(".")}:${JSON.stringify(e.value)}`
}

function unionEdits(a?: EditHistory[], b?: EditHistory[]): EditHistory[] {
  const byKey = new Map<string, EditHistory>()
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    if (!byKey.has(editKey(e))) byKey.set(editKey(e), e)
  }
  return [...byKey.values()].sort((x, y) => x.timestamp - y.timestamp)
}

/**
 * Insert cells that only exist on theirs into a base list of cells, preserving
 * their relative position from theirs' order via nearest-shared-id anchoring.
 */
function insertTheirsOnly(
  base: CodexCell[],
  theirsOrder: CodexCell[],
  theirsOnly: Map<string, CodexCell>,
): CodexCell[] {
  if (theirsOnly.size === 0) return base
  const baseIds = new Set(base.map(c => c.metadata.id))
  const theirIdxById = new Map(theirsOrder.map((c, i) => [c.metadata.id, i] as const))
  const out = [...base]

  // Iterate theirs-only cells in theirs' original order.
  const theirsOnlyInOrder = theirsOrder.filter(c => theirsOnly.has(c.metadata.id))

  for (const cell of theirsOnlyInOrder) {
    const idx = theirIdxById.get(cell.metadata.id)!
    // Find nearest predecessor in theirs' order that also exists in `out`.
    let anchor: string | undefined
    let anchorSide: "before" | "after" = "after"
    for (let j = idx - 1; j >= 0; j--) {
      const id = theirsOrder[j].metadata.id
      if (baseIds.has(id)) { anchor = id; anchorSide = "after"; break }
    }
    if (!anchor) {
      for (let j = idx + 1; j < theirsOrder.length; j++) {
        const id = theirsOrder[j].metadata.id
        if (baseIds.has(id)) { anchor = id; anchorSide = "before"; break }
      }
    }

    if (!anchor) {
      out.push(cell)
    } else {
      const at = out.findIndex(c => c.metadata.id === anchor)
      const insertAt = anchorSide === "after" ? at + 1 : at
      out.splice(insertAt, 0, cell)
    }
    baseIds.add(cell.metadata.id)
  }
  return out
}

export async function resolveCodexTwoWay(
  ourBytes: string,
  theirBytes: string,
): Promise<string> {
  if (!ourBytes) return theirBytes
  if (!theirBytes) return ourBytes

  const ourNotebook: CodexNotebookFile = JSON.parse(ourBytes)
  const theirNotebook: CodexNotebookFile = JSON.parse(theirBytes)

  const ourMeta: CodexNotebookMetadata = ourNotebook.metadata ?? ({} as CodexNotebookMetadata)
  const theirMeta: CodexNotebookMetadata = theirNotebook.metadata ?? ({} as CodexNotebookMetadata)

  const mergedMeta: CodexNotebookMetadata = {
    ...ourMeta,
    ...theirMeta,    // theirs overrides simple scalars; edits merged below
    edits: unionEdits(ourMeta.edits, theirMeta.edits),
  }

  const theirById = new Map<string, CodexCell>()
  for (const c of theirNotebook.cells) {
    if (c.metadata?.id) theirById.set(c.metadata.id, c)
  }

  const merged: CodexCell[] = []
  for (const ourCell of ourNotebook.cells) {
    const id = ourCell.metadata?.id
    if (!id) continue
    const theirCell = theirById.get(id)
    if (theirCell) {
      merged.push(mergeTwoCellsUsingResolverLogic(ourCell, theirCell))
      theirById.delete(id)
    } else {
      merged.push(ourCell)
    }
  }

  const withTheirsOnly = insertTheirsOnly(merged, theirNotebook.cells, theirById)

  // Safety pass: filter invalid validatedBy entries per cell.
  for (const c of withTheirsOnly) {
    const edits = c.metadata?.edits
    if (!edits) continue
    for (const e of edits) {
      if (e.validatedBy) e.validatedBy = e.validatedBy.filter(isValidValidationEntry)
    }
  }

  return JSON.stringify(
    { ...ourNotebook, cells: withTheirsOnly, metadata: mergedMeta },
    null, 2,
  )
}
```

- [ ] **Step 2.5: Re-export from merge index**

Edit `src/lib/codex-editor/merge/index.ts`:

```ts
export * from "./validators"
export * from "./cells"
export * from "./comments"
export * from "./resolveCodex"
```

- [ ] **Step 2.6: Run test to verify it passes**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/resolveCodex.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 2.7: Commit**

```bash
git add src/lib/codex-editor/types.ts \
        src/lib/codex-editor/merge/resolveCodex.ts \
        src/lib/codex-editor/merge/index.ts \
        src/lib/codex-editor/merge/__test__/resolveCodex.test.ts
git commit -m "feat(m13.3): resolveCodexTwoWay — cell + edit ledger union"
```

---

## Task 3: Resolve `.project/comments.json` two-way

**Files:**
- Create: `src/lib/codex-editor/merge/resolveComments.ts`
- Test: `src/lib/codex-editor/merge/__test__/resolveComments.test.ts`

Note: web-app stores comments as `CodexCommentsFile = Record<threadId, CodexCommentThread>` (from `types.ts:114`), not an array — the comments file is already keyed by id. Treat it as an object map.

- [ ] **Step 3.1: Write the failing test**

```ts
// src/lib/codex-editor/merge/__test__/resolveComments.test.ts
import { describe, it, expect } from "vitest"
import { resolveCommentsTwoWay } from "../resolveComments"
import type { CodexCommentThread, CodexComment } from "@/lib/codex-editor/types"

const c = (id: string, body: string, ts: number, author = "a"): CodexComment => ({
  id, body, timestamp: ts, mode: 0, deleted: false, author: { name: author },
})

const thread = (id: string, comments: CodexComment[], extras: Partial<CodexCommentThread> = {}): CodexCommentThread => ({
  id,
  cellId: { cellId: "cell-1" },
  comments,
  collapsibleState: 0,
  canReply: true,
  ...extras,
})

const file = (threads: CodexCommentThread[]) => JSON.stringify(
  Object.fromEntries(threads.map(t => [t.id, t])),
)

describe("resolveCommentsTwoWay", () => {
  it("unions disjoint threads", async () => {
    const ours = file([thread("t1", [c("c1", "hi", 1)])])
    const theirs = file([thread("t2", [c("c2", "hey", 2)])])
    const merged = JSON.parse(await resolveCommentsTwoWay(ours, theirs))
    expect(Object.keys(merged).sort()).toEqual(["t1", "t2"])
  })

  it("unions comments inside a shared thread by id", async () => {
    const ours = file([thread("t1", [c("c1", "hi", 1)])])
    const theirs = file([thread("t1", [c("c2", "hey", 2)])])
    const merged = JSON.parse(await resolveCommentsTwoWay(ours, theirs))
    expect(merged.t1.comments.map((x: CodexComment) => x.id).sort()).toEqual(["c1", "c2"])
  })

  it("dedupes legacy comments by (body, author)", async () => {
    const ours = file([thread("t1", [{ ...c("", "same", 1), id: "" }])])
    const theirs = file([thread("t1", [{ ...c("", "same", 1), id: "" }])])
    const merged = JSON.parse(await resolveCommentsTwoWay(ours, theirs))
    expect(merged.t1.comments).toHaveLength(1)
  })

  it("takes thread-level metadata from side with newer comment", async () => {
    const ours = file([thread("t1", [c("c1", "hi", 10)], { threadTitle: "Old" })])
    const theirs = file([thread("t1", [c("c2", "hey", 20)], { threadTitle: "New" })])
    const merged = JSON.parse(await resolveCommentsTwoWay(ours, theirs))
    expect(merged.t1.threadTitle).toBe("New")
  })

  it("unions deletionEvent arrays", async () => {
    const ev1 = { timestamp: 5, author: { name: "a" }, deleted: true }
    const ev2 = { timestamp: 7, author: { name: "b" }, deleted: true }
    const ours = file([thread("t1", [c("c1", "x", 1)], { deletionEvent: [ev1] })])
    const theirs = file([thread("t1", [c("c1", "x", 1)], { deletionEvent: [ev2] })])
    const merged = JSON.parse(await resolveCommentsTwoWay(ours, theirs))
    expect(merged.t1.deletionEvent).toHaveLength(2)
  })

  it("returns theirs when ours is empty", async () => {
    const out = await resolveCommentsTwoWay("", file([thread("t1", [])]))
    expect(JSON.parse(out).t1).toBeTruthy()
  })
})
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/resolveComments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement `resolveComments.ts`**

```ts
// src/lib/codex-editor/merge/resolveComments.ts
// Two-way merge for comments.json. Ported from codex-editor/src/projectManager/
// utils/merge/resolvers.ts:1277-1611 adapted for the object-map file shape
// used by the web app (Record<threadId, CodexCommentThread>).

import type {
  CodexCommentsFile, CodexCommentThread, CodexComment,
} from "@/lib/codex-editor/types"

type EventEntry = { timestamp: number; author: { name: string } }

function unionEvents<T extends EventEntry>(a?: T[], b?: T[]): T[] {
  const byKey = new Map<string, T>()
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    byKey.set(`${e.timestamp}:${e.author?.name ?? ""}`, e)
  }
  return [...byKey.values()].sort((x, y) => x.timestamp - y.timestamp)
}

function mergeThread(ours: CodexCommentThread, theirs: CodexCommentThread): CodexCommentThread {
  const byId = new Map<string, CodexComment>()
  const sigSeen = new Set<string>()
  const sig = (c: CodexComment) => `${c.body}|${c.author?.name ?? ""}`

  for (const cmt of ours.comments) {
    byId.set(cmt.id || sig(cmt), cmt)
    sigSeen.add(sig(cmt))
  }
  for (const cmt of theirs.comments) {
    const key = cmt.id || sig(cmt)
    if (byId.has(key)) continue
    if (!cmt.id && sigSeen.has(sig(cmt))) continue
    byId.set(key, cmt)
    sigSeen.add(sig(cmt))
  }

  const ourLatest = ours.comments.reduce((m, c) => Math.max(m, c.timestamp), 0)
  const theirLatest = theirs.comments.reduce((m, c) => Math.max(m, c.timestamp), 0)
  const base = theirLatest > ourLatest ? { ...theirs } : { ...ours }

  return {
    ...base,
    comments: [...byId.values()].sort((a, b) => a.timestamp - b.timestamp),
    deletionEvent: unionEvents(ours.deletionEvent, theirs.deletionEvent),
    resolvedEvent: unionEvents(ours.resolvedEvent, theirs.resolvedEvent),
  }
}

export async function resolveCommentsTwoWay(
  ourBytes: string,
  theirBytes: string,
): Promise<string> {
  if (!ourBytes) return theirBytes
  if (!theirBytes) return ourBytes

  const ours: CodexCommentsFile = JSON.parse(ourBytes)
  const theirs: CodexCommentsFile = JSON.parse(theirBytes)

  const merged: CodexCommentsFile = { ...ours }
  for (const [id, theirThread] of Object.entries(theirs)) {
    const ourThread = merged[id]
    merged[id] = ourThread ? mergeThread(ourThread, theirThread) : theirThread
  }

  return JSON.stringify(merged, null, 2)
}
```

- [ ] **Step 3.4: Re-export from merge index**

Edit `src/lib/codex-editor/merge/index.ts`:

```ts
export * from "./validators"
export * from "./cells"
export * from "./comments"
export * from "./resolveCodex"
export * from "./resolveComments"
```

- [ ] **Step 3.5: Run test to verify it passes**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/resolveComments.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 3.6: Commit**

```bash
git add src/lib/codex-editor/merge/resolveComments.ts \
        src/lib/codex-editor/merge/index.ts \
        src/lib/codex-editor/merge/__test__/resolveComments.test.ts
git commit -m "feat(m13.3): resolveCommentsTwoWay — thread + comment union by id"
```

---

## Task 4: Resolve `metadata.json` two-way

**Files:**
- Create: `src/lib/codex-editor/merge/resolveMetadata.ts`
- Test: `src/lib/codex-editor/merge/__test__/resolveMetadata.test.ts`

- [ ] **Step 4.1: Write the failing test**

```ts
// src/lib/codex-editor/merge/__test__/resolveMetadata.test.ts
import { describe, it, expect } from "vitest"
import { resolveMetadataTwoWay } from "../resolveMetadata"

describe("resolveMetadataTwoWay", () => {
  it("unions metadata.edits by (timestamp, editMap, value)", async () => {
    const ours = JSON.stringify({
      projectName: "proj",
      edits: [{ editMap: ["projectName"], value: "proj", timestamp: 1, author: "a", type: "user-edit" }],
    })
    const theirs = JSON.stringify({
      projectName: "new",
      edits: [{ editMap: ["projectName"], value: "new", timestamp: 10, author: "b", type: "user-edit" }],
    })
    const merged = JSON.parse(await resolveMetadataTwoWay(ours, theirs))
    expect(merged.edits).toHaveLength(2)
    expect(merged.projectName).toBe("new") // latest by timestamp wins at the key
  })

  it("prefers theirs for keys with no edit trail", async () => {
    const ours = JSON.stringify({ legacyField: "old" })
    const theirs = JSON.stringify({ legacyField: "theirs-wins" })
    const merged = JSON.parse(await resolveMetadataTwoWay(ours, theirs))
    expect(merged.legacyField).toBe("theirs-wins")
  })

  it("keeps both-sides-only keys", async () => {
    const ours = JSON.stringify({ a: 1 })
    const theirs = JSON.stringify({ b: 2 })
    const merged = JSON.parse(await resolveMetadataTwoWay(ours, theirs))
    expect(merged).toMatchObject({ a: 1, b: 2 })
  })

  it("returns theirs when ours is empty", async () => {
    const out = await resolveMetadataTwoWay("", JSON.stringify({ a: 1 }))
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })
})
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/resolveMetadata.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement `resolveMetadata.ts`**

```ts
// src/lib/codex-editor/merge/resolveMetadata.ts
// Two-way merge for metadata.json. Same edit-ledger semantics as .codex
// file-level metadata, but operates on a flat record.

import type { EditHistory } from "@/lib/codex-editor/types"

function editKey(e: EditHistory): string {
  return `${e.timestamp}:${e.editMap.join(".")}:${JSON.stringify(e.value)}`
}

function unionEdits(a?: EditHistory[], b?: EditHistory[]): EditHistory[] {
  const byKey = new Map<string, EditHistory>()
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    if (!byKey.has(editKey(e))) byKey.set(editKey(e), e)
  }
  return [...byKey.values()].sort((x, y) => x.timestamp - y.timestamp)
}

export async function resolveMetadataTwoWay(
  ourBytes: string,
  theirBytes: string,
): Promise<string> {
  if (!ourBytes) return theirBytes
  if (!theirBytes) return ourBytes

  const ours = JSON.parse(ourBytes) as Record<string, unknown> & { edits?: EditHistory[] }
  const theirs = JSON.parse(theirBytes) as Record<string, unknown> & { edits?: EditHistory[] }

  const mergedEdits = unionEdits(ours.edits, theirs.edits)

  // Start from union of keys: theirs overrides for keys with no edit trail.
  const out: Record<string, unknown> = { ...ours, ...theirs, edits: mergedEdits }

  // For keys that have edit entries, derive their value from the latest edit
  // per editMap-root path (first segment of editMap).
  const latestByRoot = new Map<string, EditHistory>()
  for (const e of mergedEdits) {
    const root = e.editMap[0]
    if (!root) continue
    const prev = latestByRoot.get(root)
    if (!prev || e.timestamp > prev.timestamp) latestByRoot.set(root, e)
  }
  for (const [root, e] of latestByRoot.entries()) {
    if (e.editMap.length === 1) {
      out[root] = e.value
    }
    // Nested paths (length > 1) left to callers; metadata.json is typically flat.
  }

  return JSON.stringify(out, null, 2)
}
```

- [ ] **Step 4.4: Re-export from merge index**

Edit `src/lib/codex-editor/merge/index.ts`:

```ts
export * from "./validators"
export * from "./cells"
export * from "./comments"
export * from "./resolveCodex"
export * from "./resolveComments"
export * from "./resolveMetadata"
```

- [ ] **Step 4.5: Run test to verify it passes**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/resolveMetadata.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 4.6: Commit**

```bash
git add src/lib/codex-editor/merge/resolveMetadata.ts \
        src/lib/codex-editor/merge/index.ts \
        src/lib/codex-editor/merge/__test__/resolveMetadata.test.ts
git commit -m "feat(m13.3): resolveMetadataTwoWay — per-key latest-wins via edit ledger"
```

---

## Task 5: Resolve unknown `.json` two-way (deep merge)

**Files:**
- Create: `src/lib/codex-editor/merge/resolveJsonMerge.ts`
- Test: `src/lib/codex-editor/merge/__test__/resolveJsonMerge.test.ts`

- [ ] **Step 5.1: Write the failing test**

```ts
// src/lib/codex-editor/merge/__test__/resolveJsonMerge.test.ts
import { describe, it, expect, vi } from "vitest"
import { resolveJsonMergeTwoWay } from "../resolveJsonMerge"

describe("resolveJsonMergeTwoWay", () => {
  it("deep-merges nested objects", async () => {
    const ours = JSON.stringify({ a: { x: 1 }, b: 2 })
    const theirs = JSON.stringify({ a: { y: 2 }, c: 3 })
    const merged = JSON.parse(await resolveJsonMergeTwoWay(ours, theirs))
    expect(merged).toEqual({ a: { x: 1, y: 2 }, b: 2, c: 3 })
  })

  it("concatenates and dedupes arrays", async () => {
    const ours = JSON.stringify({ tags: ["a", "b"] })
    const theirs = JSON.stringify({ tags: ["b", "c"] })
    const merged = JSON.parse(await resolveJsonMergeTwoWay(ours, theirs))
    expect(merged.tags).toEqual(["a", "b", "c"])
  })

  it("takes theirs on scalar conflict and logs a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const ours = JSON.stringify({ k: "ours" })
    const theirs = JSON.stringify({ k: "theirs" })
    const merged = JSON.parse(await resolveJsonMergeTwoWay(ours, theirs))
    expect(merged.k).toBe("theirs")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("returns theirs when ours is empty", async () => {
    const out = await resolveJsonMergeTwoWay("", JSON.stringify({ a: 1 }))
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })
})
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/resolveJsonMerge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement `resolveJsonMerge.ts`**

```ts
// src/lib/codex-editor/merge/resolveJsonMerge.ts
// Two-way deep merge for arbitrary JSON files (.vscode/settings.json and the
// .json fallback). Lossy only when both sides set the same scalar key to
// different values — logs a warning and takes theirs in that case.

type JsonVal = unknown

function isObj(v: JsonVal): v is Record<string, JsonVal> {
  return v != null && typeof v === "object" && !Array.isArray(v)
}

function dedupeArray(arr: JsonVal[]): JsonVal[] {
  const seen = new Set<string>()
  const out: JsonVal[] = []
  for (const v of arr) {
    const k = JSON.stringify(v)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

function deepMerge(a: JsonVal, b: JsonVal, path = ""): JsonVal {
  if (a === undefined) return b
  if (b === undefined) return a
  if (isObj(a) && isObj(b)) {
    const out: Record<string, JsonVal> = { ...a }
    for (const k of Object.keys(b)) {
      out[k] = deepMerge(a[k], b[k], path ? `${path}.${k}` : k)
    }
    return out
  }
  if (Array.isArray(a) && Array.isArray(b)) return dedupeArray([...a, ...b])
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.warn(`[json-merge] scalar conflict at "${path}" — taking theirs`)
  }
  return b
}

export async function resolveJsonMergeTwoWay(
  ourBytes: string,
  theirBytes: string,
): Promise<string> {
  if (!ourBytes) return theirBytes
  if (!theirBytes) return ourBytes
  const ours = JSON.parse(ourBytes)
  const theirs = JSON.parse(theirBytes)
  return JSON.stringify(deepMerge(ours, theirs), null, 2)
}
```

- [ ] **Step 5.4: Re-export from merge index**

Edit `src/lib/codex-editor/merge/index.ts`:

```ts
export * from "./validators"
export * from "./cells"
export * from "./comments"
export * from "./resolveCodex"
export * from "./resolveComments"
export * from "./resolveMetadata"
export * from "./resolveJsonMerge"
```

- [ ] **Step 5.5: Run test to verify it passes**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/resolveJsonMerge.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5.6: Commit**

```bash
git add src/lib/codex-editor/merge/resolveJsonMerge.ts \
        src/lib/codex-editor/merge/index.ts \
        src/lib/codex-editor/merge/__test__/resolveJsonMerge.test.ts
git commit -m "feat(m13.3): resolveJsonMergeTwoWay — deep merge with scalar-conflict warning"
```

---

## Task 6: Top-level resolver dispatcher

**Files:**
- Create: `src/lib/codex-editor/merge/resolvers.ts`
- Test: `src/lib/codex-editor/merge/__test__/resolvers.test.ts`

- [ ] **Step 6.1: Write the failing test**

```ts
// src/lib/codex-editor/merge/__test__/resolvers.test.ts
import { describe, it, expect } from "vitest"
import { resolveTwoWay } from "../resolvers"

describe("resolveTwoWay", () => {
  it("routes .codex paths to resolveCodexTwoWay", async () => {
    const ours = JSON.stringify({ cells: [], metadata: { id: "f", originalName: "f" } })
    const theirs = JSON.stringify({ cells: [], metadata: { id: "f", originalName: "f" } })
    const out = await resolveTwoWay("files/target/gen.codex", ours, theirs)
    expect(JSON.parse(out).cells).toEqual([])
  })

  it("routes comments.json to resolveCommentsTwoWay", async () => {
    const ours = JSON.stringify({})
    const theirs = JSON.stringify({})
    const out = await resolveTwoWay(".project/comments.json", ours, theirs)
    expect(JSON.parse(out)).toEqual({})
  })

  it("takes ours for IGNORE strategy", async () => {
    const out = await resolveTwoWay("complete_drafts.txt", "ours", "theirs")
    expect(out).toBe("ours")
  })

  it("takes theirs for OVERRIDE strategy", async () => {
    const out = await resolveTwoWay("files/media/clip.mp4", "ours", "theirs")
    expect(out).toBe("theirs")
  })
})
```

- [ ] **Step 6.2: Run test to verify it fails**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/resolvers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6.3: Implement `resolvers.ts`**

```ts
// src/lib/codex-editor/merge/resolvers.ts
// Top-level dispatcher: route a (path, ours, theirs) triple to the right resolver.

import { Strategy, determineStrategy } from "./strategies"
import { resolveCodexTwoWay } from "./resolveCodex"
import { resolveCommentsTwoWay } from "./resolveComments"
import { resolveMetadataTwoWay } from "./resolveMetadata"
import { resolveJsonMergeTwoWay } from "./resolveJsonMerge"

export async function resolveTwoWay(
  path: string,
  ourBytes: string,
  theirBytes: string,
): Promise<string> {
  const strategy = determineStrategy(path)
  switch (strategy) {
    case Strategy.CODEX: return resolveCodexTwoWay(ourBytes, theirBytes)
    case Strategy.COMMENTS: return resolveCommentsTwoWay(ourBytes, theirBytes)
    case Strategy.METADATA: return resolveMetadataTwoWay(ourBytes, theirBytes)
    case Strategy.JSON_MERGE: return resolveJsonMergeTwoWay(ourBytes, theirBytes)
    case Strategy.IGNORE: return ourBytes
    case Strategy.OVERRIDE:
      console.warn(`[merge] OVERRIDE fallback for "${path}" — taking theirs`)
      return theirBytes
  }
}
```

- [ ] **Step 6.4: Re-export from merge index**

Edit `src/lib/codex-editor/merge/index.ts`:

```ts
export * from "./validators"
export * from "./cells"
export * from "./comments"
export * from "./resolveCodex"
export * from "./resolveComments"
export * from "./resolveMetadata"
export * from "./resolveJsonMerge"
export * from "./resolvers"
export * from "./strategies"
```

- [ ] **Step 6.5: Run test to verify it passes**

Run: `npx vitest run src/lib/codex-editor/merge/__test__/resolvers.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6.6: Commit**

```bash
git add src/lib/codex-editor/merge/resolvers.ts \
        src/lib/codex-editor/merge/index.ts \
        src/lib/codex-editor/merge/__test__/resolvers.test.ts
git commit -m "feat(m13.3): resolveTwoWay — path→strategy→resolver dispatch"
```

---

## Task 7: Tree diff via `git.walk`

Walks two commits' trees side-by-side, classifies every path by kind.

**Files:**
- Create: `src/lib/sync/git-merge/tree-diff.ts`
- Test: `src/lib/sync/git-merge/__test__/tree-diff.test.ts`

We use the existing `MemoryDirectoryHandle` fixture from Phase 2. Check that it's re-exportable from the test utilities.

- [ ] **Step 7.1: Confirm MemoryDirectoryHandle location**

Run: `npx grep -rn "MemoryDirectoryHandle" src/ | head -5`
Expected: find the helper in `src/test/opfs-fixture.ts` or similar. If missing, read `src/lib/sync/git-sync.test.ts` to see how fs is set up.

If `src/test/opfs-fixture.ts` does not exist, create it now by extracting the mock fs setup from `src/lib/sync/git-sync.test.ts`:

```ts
// src/test/opfs-fixture.ts
// Minimal in-memory fs suitable for isomorphic-git. Used by all git-merge tests.
import { createOpfsFs, type OpfsFs } from "@/lib/git/opfs-fs"

type Entry = { type: "file", bytes: Uint8Array } | { type: "dir", children: Map<string, Entry> }

class MemHandle {
  kind: "directory" | "file" = "directory"
  children = new Map<string, MemHandle>()
  bytes: Uint8Array | null = null
  name: string
  constructor(name = "") { this.name = name }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<MemHandle> {
    let c = this.children.get(name)
    if (!c) {
      if (!opts?.create) {
        const e = new Error(`not found: ${name}`) as Error & { name: string }
        e.name = "NotFoundError"
        throw e
      }
      c = new MemHandle(name); c.kind = "directory"; this.children.set(name, c)
    }
    if (c.kind !== "directory") {
      const e = new Error(`not a dir: ${name}`) as Error & { name: string }
      e.name = "TypeMismatchError"
      throw e
    }
    return c
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<MemHandle> {
    let c = this.children.get(name)
    if (!c) {
      if (!opts?.create) {
        const e = new Error(`not found: ${name}`) as Error & { name: string }
        e.name = "NotFoundError"
        throw e
      }
      c = new MemHandle(name); c.kind = "file"; c.bytes = new Uint8Array(); this.children.set(name, c)
    }
    return c
  }
  async getFile() { return new Blob([this.bytes ?? new Uint8Array()]) as unknown as File & { arrayBuffer: () => Promise<ArrayBuffer>; size: number; lastModified: number } }
  async createWritable() {
    return {
      write: async (d: ArrayBuffer | Uint8Array | string) => {
        if (typeof d === "string") this.bytes = new TextEncoder().encode(d)
        else this.bytes = d instanceof Uint8Array ? d : new Uint8Array(d)
      },
      close: async () => {},
    }
  }
  async removeEntry(name: string) { this.children.delete(name) }
  keys() {
    const self = this
    return (async function* () { for (const k of self.children.keys()) yield k })()
  }
}

// The minimal Blob shim expected by OpfsFs.
// Node test env has global Blob; this just wires arrayBuffer()+size+lastModified.
// If your vitest env lacks Blob, polyfill before calling.
async function fixBlob(b: Blob): Promise<File> {
  const buf = await b.arrayBuffer()
  return Object.assign(b as unknown as File, {
    arrayBuffer: async () => buf,
    size: buf.byteLength,
    lastModified: 0,
  })
}

export function createMemoryFs(): OpfsFs {
  const root = new MemHandle("/")
  const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle)
  // Patch getFile to return our File-shaped shim.
  const origGetFile = MemHandle.prototype.getFile
  MemHandle.prototype.getFile = async function () {
    return fixBlob(await origGetFile.call(this))
  }
  void fs
  return fs
}
```

If the above becomes unwieldy, use an existing fixture instead — grep for `createMemoryFs`, `MemoryDirectoryHandle`, or similar patterns already in `src/`.

- [ ] **Step 7.2: Write the failing test**

```ts
// src/lib/sync/git-merge/__test__/tree-diff.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import * as git from "isomorphic-git"
import { buildTreeDiff } from "../tree-diff"
import { createMemoryFs } from "@/test/opfs-fixture"
import type { OpfsFs } from "@/lib/git/opfs-fs"

async function init(fs: OpfsFs) {
  await git.init({ fs: fs as unknown as git.FsClient, dir: "/" })
}

async function writeAndCommit(
  fs: OpfsFs, files: Record<string, string>, message: string, parent?: string[],
): Promise<string> {
  for (const [p, contents] of Object.entries(files)) {
    await fs.promises.writeFile(p, contents)
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: p.replace(/^\//, "") })
  }
  return git.commit({
    fs: fs as unknown as git.FsClient, dir: "/",
    author: { name: "t", email: "t@t" },
    message, parent,
  })
}

describe("buildTreeDiff", () => {
  let fs: OpfsFs
  beforeEach(async () => { fs = createMemoryFs(); await init(fs) })

  it("classifies both-same paths as skipped", async () => {
    const oursSha = await writeAndCommit(fs, { "a.txt": "hello" }, "c1")
    const theirsSha = oursSha
    const entries = await buildTreeDiff({ fs, dir: "/", oursSha, theirsSha })
    expect(entries).toHaveLength(0)
  })

  it("classifies ours-only and theirs-only paths", async () => {
    const base = await writeAndCommit(fs, { "shared.txt": "x" }, "base")
    const oursSha = await writeAndCommit(fs, { "only-ours.txt": "o" }, "ours", [base])
    // Reset to base for the parallel branch.
    await fs.promises.writeFile("/only-theirs.txt", "t")
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "only-theirs.txt" })
    await fs.promises.unlink("/only-ours.txt")
    await git.remove({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "only-ours.txt" })
    const theirsSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "t", email: "t@t" }, message: "theirs", parent: [base],
    })

    const entries = await buildTreeDiff({ fs, dir: "/", oursSha, theirsSha })
    const byPath = Object.fromEntries(entries.map(e => [e.path, e.kind]))
    expect(byPath["only-ours.txt"]).toBe("ours-only")
    expect(byPath["only-theirs.txt"]).toBe("theirs-only")
  })

  it("classifies differing-content paths as both-differ", async () => {
    const base = await writeAndCommit(fs, { "shared.txt": "v1" }, "base")
    const oursSha = await writeAndCommit(fs, { "shared.txt": "v-ours" }, "ours", [base])
    await fs.promises.writeFile("/shared.txt", "v-theirs")
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "shared.txt" })
    const theirsSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "t", email: "t@t" }, message: "theirs", parent: [base],
    })
    const entries = await buildTreeDiff({ fs, dir: "/", oursSha, theirsSha })
    const e = entries.find(x => x.path === "shared.txt")
    expect(e?.kind).toBe("both-differ")
    expect(e?.oursOid).toBeDefined()
    expect(e?.theirsOid).toBeDefined()
  })
})
```

- [ ] **Step 7.3: Run test to verify it fails**

Run: `npx vitest run src/lib/sync/git-merge/__test__/tree-diff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7.4: Implement `tree-diff.ts`**

```ts
// src/lib/sync/git-merge/tree-diff.ts
import * as git from "isomorphic-git"
import type { OpfsFs } from "@/lib/git/opfs-fs"

export type DiffKind = "both-differ" | "ours-only" | "theirs-only"

export interface DiffEntry {
  path: string            // relative to repo root, no leading slash
  kind: DiffKind
  oursOid?: string
  theirsOid?: string
  mode: string            // file mode from git (e.g. "100644")
}

export interface BuildTreeDiffArgs {
  fs: OpfsFs
  dir: string             // repo dir, typically "/"
  oursSha: string
  theirsSha: string
}

export async function buildTreeDiff({
  fs, dir, oursSha, theirsSha,
}: BuildTreeDiffArgs): Promise<DiffEntry[]> {
  const out: DiffEntry[] = []
  await git.walk({
    fs: fs as unknown as git.FsClient,
    dir,
    trees: [git.TREE({ ref: oursSha }), git.TREE({ ref: theirsSha })],
    map: async (relpath, [ours, theirs]) => {
      if (relpath === ".") return
      const oursType = await ours?.type()
      const theirsType = await theirs?.type()

      // Skip pure directories — emit only leaves.
      if (oursType === "tree" || theirsType === "tree") return
      if (!ours && !theirs) return

      const oursOid = ours ? await ours.oid() : undefined
      const theirsOid = theirs ? await theirs.oid() : undefined
      if (oursOid === theirsOid) return

      const mode = (ours ? await ours.mode() : await theirs!.mode()).toString(8).padStart(6, "0")

      const kind: DiffKind =
        !oursOid ? "theirs-only" :
        !theirsOid ? "ours-only" :
        "both-differ"

      out.push({ path: relpath, kind, oursOid, theirsOid, mode })
    },
  })
  return out
}
```

- [ ] **Step 7.5: Run test to verify it passes**

Run: `npx vitest run src/lib/sync/git-merge/__test__/tree-diff.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 7.6: Commit**

```bash
git add src/test/opfs-fixture.ts \
        src/lib/sync/git-merge/tree-diff.ts \
        src/lib/sync/git-merge/__test__/tree-diff.test.ts
git commit -m "feat(m13.3): buildTreeDiff — classify paths between two commits"
```

---

## Task 8: Tree write (`buildTreeFromOursPlusOverrides`)

Take ours' root tree and produce a new root tree where specific paths are replaced with override blob OIDs.

**Files:**
- Create: `src/lib/sync/git-merge/tree-write.ts`
- Test: `src/lib/sync/git-merge/__test__/tree-write.test.ts`

- [ ] **Step 8.1: Write the failing test**

```ts
// src/lib/sync/git-merge/__test__/tree-write.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import * as git from "isomorphic-git"
import { createMemoryFs } from "@/test/opfs-fixture"
import { buildTreeFromOursPlusOverrides } from "../tree-write"
import type { OpfsFs } from "@/lib/git/opfs-fs"

async function initFixture(): Promise<{ fs: OpfsFs; sha: string }> {
  const fs = createMemoryFs()
  await git.init({ fs: fs as unknown as git.FsClient, dir: "/" })
  for (const [p, v] of [
    ["a.txt", "aaa"],
    ["nested/b.txt", "bbb"],
    ["nested/deep/c.txt", "ccc"],
  ]) {
    await fs.promises.writeFile("/" + p, v)
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: p })
  }
  const sha = await git.commit({
    fs: fs as unknown as git.FsClient, dir: "/",
    author: { name: "t", email: "t@t" }, message: "init",
  })
  return { fs, sha }
}

describe("buildTreeFromOursPlusOverrides", () => {
  it("returns ours' tree unchanged when no overrides", async () => {
    const { fs, sha } = await initFixture()
    const commit = await git.readCommit({ fs: fs as unknown as git.FsClient, dir: "/", oid: sha })
    const treeOid = await buildTreeFromOursPlusOverrides({ fs, dir: "/", oursSha: sha, overrides: [] })
    expect(treeOid).toBe(commit.commit.tree)
  })

  it("replaces a top-level file blob", async () => {
    const { fs, sha } = await initFixture()
    const { oid: newBlobOid } = await git.writeBlob({
      fs: fs as unknown as git.FsClient, dir: "/",
      blob: new TextEncoder().encode("NEW"),
    })
    const newTreeOid = await buildTreeFromOursPlusOverrides({
      fs, dir: "/", oursSha: sha,
      overrides: [{ path: "a.txt", oid: newBlobOid, mode: "100644" }],
    })
    const { blob } = await git.readBlob({ fs: fs as unknown as git.FsClient, dir: "/", oid: newTreeOid, filepath: "a.txt" } as any)
    expect(new TextDecoder().decode(blob)).toBe("NEW")
  })

  it("replaces a deeply nested blob", async () => {
    const { fs, sha } = await initFixture()
    const { oid } = await git.writeBlob({
      fs: fs as unknown as git.FsClient, dir: "/",
      blob: new TextEncoder().encode("DEEP-NEW"),
    })
    const newTreeOid = await buildTreeFromOursPlusOverrides({
      fs, dir: "/", oursSha: sha,
      overrides: [{ path: "nested/deep/c.txt", oid, mode: "100644" }],
    })
    const { blob } = await git.readBlob({ fs: fs as unknown as git.FsClient, dir: "/", oid: newTreeOid, filepath: "nested/deep/c.txt" } as any)
    expect(new TextDecoder().decode(blob)).toBe("DEEP-NEW")
  })

  it("adds a new file that didn't exist in ours", async () => {
    const { fs, sha } = await initFixture()
    const { oid } = await git.writeBlob({
      fs: fs as unknown as git.FsClient, dir: "/",
      blob: new TextEncoder().encode("NEWFILE"),
    })
    const newTreeOid = await buildTreeFromOursPlusOverrides({
      fs, dir: "/", oursSha: sha,
      overrides: [{ path: "brandnew.txt", oid, mode: "100644" }],
    })
    const { blob } = await git.readBlob({ fs: fs as unknown as git.FsClient, dir: "/", oid: newTreeOid, filepath: "brandnew.txt" } as any)
    expect(new TextDecoder().decode(blob)).toBe("NEWFILE")
  })
})
```

- [ ] **Step 8.2: Run test to verify it fails**

Run: `npx vitest run src/lib/sync/git-merge/__test__/tree-write.test.ts`
Expected: FAIL.

- [ ] **Step 8.3: Implement `tree-write.ts`**

```ts
// src/lib/sync/git-merge/tree-write.ts
import * as git from "isomorphic-git"
import type { OpfsFs } from "@/lib/git/opfs-fs"

export interface Override {
  path: string       // relative to repo root, no leading slash
  oid: string        // blob oid
  mode: string       // git mode (e.g. "100644")
}

export interface BuildTreeArgs {
  fs: OpfsFs
  dir: string
  oursSha: string
  overrides: Override[]
}

/**
 * Rebuild a root tree by overlaying ours' tree with a set of blob overrides.
 * Each override path can be deeply nested; we recursively rewrite intermediate
 * tree objects as needed.
 */
export async function buildTreeFromOursPlusOverrides({
  fs, dir, oursSha, overrides,
}: BuildTreeArgs): Promise<string> {
  const commit = await git.readCommit({ fs: fs as unknown as git.FsClient, dir, oid: oursSha })
  const rootOid = commit.commit.tree

  if (overrides.length === 0) return rootOid

  interface Node {
    subdirs: Map<string, Node>           // name → subdir overlay
    files: Map<string, { oid: string; mode: string }>
  }
  const overlayRoot: Node = { subdirs: new Map(), files: new Map() }

  for (const o of overrides) {
    const parts = o.path.split("/").filter(Boolean)
    let cur = overlayRoot
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      let child = cur.subdirs.get(name)
      if (!child) {
        child = { subdirs: new Map(), files: new Map() }
        cur.subdirs.set(name, child)
      }
      cur = child
    }
    cur.files.set(parts[parts.length - 1], { oid: o.oid, mode: o.mode })
  }

  async function writeTreeAt(treeOid: string | null, overlay: Node): Promise<string> {
    interface TreeEntry { mode: string; path: string; oid: string; type: "blob" | "tree" | "commit" }
    const existing: TreeEntry[] = treeOid
      ? (await git.readTree({ fs: fs as unknown as git.FsClient, dir, oid: treeOid })).tree as unknown as TreeEntry[]
      : []

    const byName = new Map<string, TreeEntry>()
    for (const e of existing) byName.set(e.path, e)

    // Apply file overrides.
    for (const [name, fileOverride] of overlay.files.entries()) {
      byName.set(name, {
        mode: fileOverride.mode,
        path: name,
        oid: fileOverride.oid,
        type: "blob",
      })
    }

    // Recurse into subdirectories that have overlay content.
    for (const [name, sub] of overlay.subdirs.entries()) {
      const existingEntry = byName.get(name)
      const childTreeOid = existingEntry && existingEntry.type === "tree" ? existingEntry.oid : null
      const newSubOid = await writeTreeAt(childTreeOid, sub)
      byName.set(name, { mode: "040000", path: name, oid: newSubOid, type: "tree" })
    }

    const finalEntries = [...byName.values()].sort((a, b) => a.path < b.path ? -1 : 1)
    const { oid } = await git.writeTree({
      fs: fs as unknown as git.FsClient, dir,
      tree: finalEntries as unknown as Parameters<typeof git.writeTree>[0]["tree"],
    })
    return oid
  }

  return writeTreeAt(rootOid, overlayRoot)
}
```

- [ ] **Step 8.4: Run test to verify it passes**

Run: `npx vitest run src/lib/sync/git-merge/__test__/tree-write.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 8.5: Commit**

```bash
git add src/lib/sync/git-merge/tree-write.ts \
        src/lib/sync/git-merge/__test__/tree-write.test.ts
git commit -m "feat(m13.3): buildTreeFromOursPlusOverrides — overlay merged blobs"
```

---

## Task 9: `mergeRemoteIntoOurs` orchestrator

Ties tree-diff + resolvers + tree-write + commit into one operation. Also handles the backup-ref failure path.

**Files:**
- Create: `src/lib/sync/git-merge/index.ts`
- Test: `src/lib/sync/git-merge/__test__/git-merge.test.ts`

- [ ] **Step 9.1: Write the failing test**

```ts
// src/lib/sync/git-merge/__test__/git-merge.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import * as git from "isomorphic-git"
import { createMemoryFs } from "@/test/opfs-fixture"
import { mergeRemoteIntoOurs } from "../index"
import type { OpfsFs } from "@/lib/git/opfs-fs"

async function write(fs: OpfsFs, path: string, content: string) {
  await fs.promises.writeFile(path, content)
  await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: path.replace(/^\//, "") })
}

async function commit(fs: OpfsFs, msg: string, parent?: string[]) {
  return git.commit({
    fs: fs as unknown as git.FsClient, dir: "/",
    author: { name: "t", email: "t@t" }, message: msg, parent,
  })
}

describe("mergeRemoteIntoOurs", () => {
  let fs: OpfsFs
  beforeEach(async () => { fs = createMemoryFs(); await git.init({ fs: fs as unknown as git.FsClient, dir: "/" }) })

  it("produces a two-parent merge commit whose tree includes overrides", async () => {
    const baseNb = JSON.stringify({
      cells: [{ kind: 2, languageId: "html", value: "hi", metadata: { id: "c1", type: "text", edits: [] } }],
      metadata: { id: "f", originalName: "f" },
    })
    await write(fs, "/files/target/f.codex", baseNb)
    const baseSha = await commit(fs, "base")

    const oursNb = JSON.stringify({
      cells: [{ kind: 2, languageId: "html", value: "ours", metadata: { id: "c1", type: "text",
        edits: [{ editMap: ["value"], value: "ours", timestamp: 10, author: "a", type: "user-edit" }] } }],
      metadata: { id: "f", originalName: "f" },
    })
    await write(fs, "/files/target/f.codex", oursNb)
    const oursSha = await commit(fs, "ours", [baseSha])

    // Fabricate theirs branch from base with a different edit.
    const theirsNb = JSON.stringify({
      cells: [{ kind: 2, languageId: "html", value: "theirs", metadata: { id: "c1", type: "text",
        edits: [{ editMap: ["value"], value: "theirs", timestamp: 20, author: "b", type: "user-edit" }] } }],
      metadata: { id: "f", originalName: "f" },
    })
    await fs.promises.writeFile("/files/target/f.codex", theirsNb)
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "files/target/f.codex" })
    const theirsSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "b", email: "b@b" }, message: "theirs", parent: [baseSha],
    })

    const { mergeSha, touchedPaths } = await mergeRemoteIntoOurs({
      fs, dir: "/",
      oursSha, theirsSha,
      author: { name: "t", email: "t@t" },
    })

    expect(touchedPaths).toContain("files/target/f.codex")

    const merge = await git.readCommit({ fs: fs as unknown as git.FsClient, dir: "/", oid: mergeSha })
    expect(merge.commit.parent).toEqual([oursSha, theirsSha])

    // Verify the merged file contains both edits.
    const { blob } = await git.readBlob({
      fs: fs as unknown as git.FsClient, dir: "/",
      oid: merge.commit.tree, filepath: "files/target/f.codex",
    })
    const parsed = JSON.parse(new TextDecoder().decode(blob))
    expect(parsed.cells[0].metadata.edits.map((e: { value: string }) => e.value).sort())
      .toEqual(["ours", "theirs"])
    expect(parsed.cells[0].value).toBe("theirs") // latest ts wins
  })

  it("on resolver throw creates a backup ref and throws", async () => {
    // Write a path that routes to JSON_MERGE with broken JSON on theirs' side.
    await write(fs, "/bad.json", JSON.stringify({ x: 1 }))
    const baseSha = await commit(fs, "base")
    await write(fs, "/bad.json", JSON.stringify({ x: 2 }))
    const oursSha = await commit(fs, "ours", [baseSha])
    // Commit intentionally-broken theirs.
    await fs.promises.writeFile("/bad.json", "{not valid json")
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "bad.json" })
    const theirsSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      author: { name: "b", email: "b@b" }, message: "theirs", parent: [baseSha],
    })

    await expect(
      mergeRemoteIntoOurs({ fs, dir: "/", oursSha, theirsSha, author: { name: "t", email: "t@t" } }),
    ).rejects.toThrow(/couldn't auto-merge/i)

    // Backup ref should exist and point at oursSha.
    const refs = await git.listBranches({ fs: fs as unknown as git.FsClient, dir: "/" })
    const backup = refs.find(r => r.startsWith("codex-web/backup-"))
    expect(backup).toBeTruthy()
    const backupOid = await git.resolveRef({
      fs: fs as unknown as git.FsClient, dir: "/", ref: `refs/heads/${backup}`,
    })
    expect(backupOid).toBe(oursSha)
  })
})
```

- [ ] **Step 9.2: Run test to verify it fails**

Run: `npx vitest run src/lib/sync/git-merge/__test__/git-merge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 9.3: Implement `index.ts`**

```ts
// src/lib/sync/git-merge/index.ts
import * as git from "isomorphic-git"
import type { OpfsFs } from "@/lib/git/opfs-fs"
import { buildTreeDiff, type DiffEntry } from "./tree-diff"
import { buildTreeFromOursPlusOverrides, type Override } from "./tree-write"
import { resolveTwoWay } from "@/lib/codex-editor/merge/resolvers"

export interface MergeArgs {
  fs: OpfsFs
  dir: string
  oursSha: string
  theirsSha: string
  author: { name: string; email: string }
  message?: string
}

export interface MergeResult {
  mergeSha: string
  touchedPaths: string[]
}

export class MergeFailure extends Error {
  backupRef?: string
  constructor(message: string, opts: { backupRef?: string } = {}) {
    super(message)
    this.name = "MergeFailure"
    this.backupRef = opts.backupRef
  }
}

async function readBlobText(
  fs: OpfsFs, dir: string, oid: string,
): Promise<string> {
  const { blob } = await git.readBlob({ fs: fs as unknown as git.FsClient, dir, oid })
  return new TextDecoder().decode(blob)
}

async function writeBlobText(
  fs: OpfsFs, dir: string, text: string,
): Promise<string> {
  const { oid } = await git.writeBlob({
    fs: fs as unknown as git.FsClient, dir,
    blob: new TextEncoder().encode(text),
  })
  return oid
}

export async function mergeRemoteIntoOurs({
  fs, dir, oursSha, theirsSha, author, message,
}: MergeArgs): Promise<MergeResult> {
  const diff = await buildTreeDiff({ fs, dir, oursSha, theirsSha })
  const overrides: Override[] = []
  const touchedPaths: string[] = []
  const failures: Array<{ path: string; reason: string }> = []

  for (const entry of diff) {
    if (entry.kind === "ours-only") continue  // ours already has it; no override needed
    if (entry.kind === "theirs-only") {
      overrides.push({ path: entry.path, oid: entry.theirsOid!, mode: entry.mode })
      touchedPaths.push(entry.path)
      continue
    }
    // both-differ → resolve
    try {
      const ourText = await readBlobText(fs, dir, entry.oursOid!)
      const theirText = await readBlobText(fs, dir, entry.theirsOid!)
      const resolved = await resolveTwoWay(entry.path, ourText, theirText)
      if (resolved === ourText) continue  // resolver returned ours verbatim → no override
      const newOid = await writeBlobText(fs, dir, resolved)
      overrides.push({ path: entry.path, oid: newOid, mode: entry.mode })
      touchedPaths.push(entry.path)
    } catch (e) {
      failures.push({
        path: entry.path,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (failures.length > 0) {
    const backupRef = `codex-web/backup-${new Date().toISOString().replace(/[:.]/g, "-")}`
    await git.writeRef({
      fs: fs as unknown as git.FsClient, dir,
      ref: `refs/heads/${backupRef}`,
      value: oursSha, force: true,
    })
    const summary = failures.map(f => `  • ${f.path}: ${f.reason}`).join("\n")
    throw new MergeFailure(
      `Couldn't auto-merge ${failures.length} file(s) — your work is safe on branch ${backupRef}.\n${summary}`,
      { backupRef },
    )
  }

  const mergeTreeOid = await buildTreeFromOursPlusOverrides({ fs, dir, oursSha, overrides })

  const mergeSha = await git.commit({
    fs: fs as unknown as git.FsClient, dir,
    tree: mergeTreeOid,
    parent: [oursSha, theirsSha],
    author, committer: author,
    message: message ?? `merge: sync with ${theirsSha.slice(0, 7)}`,
  })

  return { mergeSha, touchedPaths }
}
```

- [ ] **Step 9.4: Run test to verify it passes**

Run: `npx vitest run src/lib/sync/git-merge/__test__/git-merge.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 9.5: Commit**

```bash
git add src/lib/sync/git-merge/index.ts \
        src/lib/sync/git-merge/__test__/git-merge.test.ts
git commit -m "feat(m13.3): mergeRemoteIntoOurs — orchestrator + backup-ref failure path"
```

---

## Task 10: Rehydrate `FileDocHandle` from merged bytes

Replace a live Y.Doc's `cells`/`order`/`meta` contents from merged `.codex` bytes inside a single `doc.transact()`. Preserves handle identity so open editors see atomic replacement.

**Files:**
- Modify: `src/lib/store/file-doc.ts`
- Test: `src/lib/store/file-doc.rehydrate.test.ts`

- [ ] **Step 10.1: Read the existing file-doc.ts**

Run: `cat src/lib/store/file-doc.ts` to see current exports. You will add `rehydrateFileDoc`.

- [ ] **Step 10.2: Write the failing test**

```ts
// src/lib/store/file-doc.rehydrate.test.ts
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { rehydrateFileDoc } from "./file-doc"
import type { CodexNotebookFile } from "@/lib/codex-editor/types"

function seedDoc(cells: Array<{ id: string; value: string }>): Y.Doc {
  const doc = new Y.Doc()
  const cellsMap = doc.getMap("cells")
  const order = doc.getArray<string>("order")
  doc.transact(() => {
    for (const c of cells) {
      const y = new Y.Map<unknown>()
      y.set("value", c.value)
      y.set("id", c.id)
      y.set("history", new Y.Array<unknown>())
      cellsMap.set(c.id, y)
      order.push([c.id])
    }
    doc.getMap("meta").set("__source", { id: "f", originalName: "f" })
  })
  return doc
}

describe("rehydrateFileDoc", () => {
  it("replaces cell state atomically", () => {
    const doc = seedDoc([{ id: "c1", value: "old" }])
    const merged: CodexNotebookFile = {
      cells: [
        { kind: 2, languageId: "html", value: "new",
          metadata: { id: "c1", type: "text",
            edits: [{ editMap: ["value"], value: "new", timestamp: 10, author: "a", type: "user-edit" }] } },
        { kind: 2, languageId: "html", value: "added",
          metadata: { id: "c2", type: "text", edits: [] } },
      ],
      metadata: { id: "f", originalName: "f" },
    }
    rehydrateFileDoc(doc, merged, Date.now())
    const cells = doc.getMap("cells")
    const order = doc.getArray<string>("order").toArray()
    expect(order).toEqual(["c1", "c2"])
    const c1 = cells.get("c1") as Y.Map<unknown>
    expect(c1.get("value")).toBe("new")
  })

  it("removes cells no longer in merged output", () => {
    const doc = seedDoc([{ id: "c1", value: "x" }, { id: "c2", value: "y" }])
    const merged: CodexNotebookFile = {
      cells: [{ kind: 2, languageId: "html", value: "only",
        metadata: { id: "c1", type: "text", edits: [] } }],
      metadata: { id: "f", originalName: "f" },
    }
    rehydrateFileDoc(doc, merged, Date.now())
    const cells = doc.getMap("cells")
    expect(cells.has("c2")).toBe(false)
  })

  it("bumps __lastSyncedHistoryAt on every remaining cell", () => {
    const doc = seedDoc([{ id: "c1", value: "x" }])
    const merged: CodexNotebookFile = {
      cells: [{ kind: 2, languageId: "html", value: "x",
        metadata: { id: "c1", type: "text", edits: [] } }],
      metadata: { id: "f", originalName: "f" },
    }
    const ts = 123456
    rehydrateFileDoc(doc, merged, ts)
    const c1 = doc.getMap("cells").get("c1") as Y.Map<unknown>
    expect(c1.get("__lastSyncedHistoryAt")).toBe(ts)
  })
})
```

- [ ] **Step 10.3: Run test to verify it fails**

Run: `npx vitest run src/lib/store/file-doc.rehydrate.test.ts`
Expected: FAIL — `rehydrateFileDoc` not exported.

- [ ] **Step 10.4: Add `rehydrateFileDoc` to `file-doc.ts`**

Append to `src/lib/store/file-doc.ts`:

```ts
// --- Phase 3: rehydration from merged notebook bytes ---

import type { CodexNotebookFile, EditHistory } from "@/lib/codex-editor/types"
// (Keep existing imports; add these if not already present.)

/**
 * Replace the contents of a Y.Doc wholesale from a parsed merged notebook.
 * Performed inside a single transact() so persistence writes-through once.
 */
export function rehydrateFileDoc(
  doc: Y.Doc,
  merged: CodexNotebookFile,
  syncedAt: number,
): void {
  doc.transact(() => {
    const cellsMap = doc.getMap("cells")
    const order = doc.getArray<string>("order")
    const meta = doc.getMap("meta")

    // Remove cells no longer present.
    const mergedIds = new Set(merged.cells.map(c => c.metadata.id))
    for (const id of [...cellsMap.keys()]) {
      if (!mergedIds.has(id)) cellsMap.delete(id)
    }

    // Upsert cells.
    for (const cell of merged.cells) {
      const id = cell.metadata.id
      let yCell = cellsMap.get(id) as Y.Map<unknown> | undefined
      if (!yCell) {
        yCell = new Y.Map<unknown>()
        cellsMap.set(id, yCell)
      }
      yCell.set("id", id)
      yCell.set("value", cell.value)
      yCell.set("kind", cell.kind)
      yCell.set("languageId", cell.languageId)
      yCell.set("type", cell.metadata.type)
      if (cell.metadata.data !== undefined) yCell.set("data", cell.metadata.data)
      if (cell.metadata.cellLabel !== undefined) yCell.set("cellLabel", cell.metadata.cellLabel)

      // Replace history with merged edit entries.
      const histArr = yCell.get("history") as Y.Array<EditHistory> | undefined
      if (histArr) {
        histArr.delete(0, histArr.length)
      } else {
        yCell.set("history", new Y.Array<EditHistory>())
      }
      const freshHist = yCell.get("history") as Y.Array<EditHistory>
      for (const e of cell.metadata.edits ?? []) freshHist.push([e])

      yCell.set("__lastSyncedHistoryAt", syncedAt)
    }

    // Reset order.
    order.delete(0, order.length)
    for (const cell of merged.cells) order.push([cell.metadata.id])

    // Replace __source metadata stash.
    meta.set("__source", merged.metadata)
  })
}
```

- [ ] **Step 10.5: Run test to verify it passes**

Run: `npx vitest run src/lib/store/file-doc.rehydrate.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 10.6: Commit**

```bash
git add src/lib/store/file-doc.ts src/lib/store/file-doc.rehydrate.test.ts
git commit -m "feat(m13.3): rehydrateFileDoc — atomic Y.Doc replacement from merged notebook"
```

---

## Task 11: Wire merge into `syncProject`

Replace Phase 2's `remote-moved` early-return with a real merge-and-push branch. Fetch deeper so ancestry is reachable; detect divergence; run `mergeRemoteIntoOurs`; push; then rehydrate each touched `FileDocHandle`.

**Files:**
- Modify: `src/lib/sync/git-sync.ts`
- Test: extend `src/lib/sync/git-sync.test.ts` with a merge scenario.

- [ ] **Step 11.1: Extend `SyncResult` and `SyncPhase`**

Edit `src/lib/sync/git-sync.ts`:

```ts
// Near the top, extend SyncPhase:
export type SyncPhase =
  | "idle"
  | "checking-dirty"
  | "serializing"
  | "writing"
  | "committing"
  | "merging"          // NEW
  | "rehydrating"      // NEW
  | "pushing"
  | "done"
  | "error"
  | "remote-moved"

// Extend SyncResult with mergeSha + touched paths:
export interface SyncResult {
  status: "synced" | "no-changes" | "remote-moved" | "merged" | "error"
  commitSha?: string
  mergeSha?: string
  touchedPaths?: string[]
  filesWritten?: number
  backupRef?: string
  message?: string
}
```

- [ ] **Step 11.2: Increase fetch depth and capture `theirsSha` explicitly**

Edit `src/lib/sync/git-sync.ts` — change `depth: 1` to `depth: 50` in the fetch call (a compromise between transfer size and enough history for merges). Preserve all other existing behavior.

```ts
await git.fetch({
  fs: fs as unknown as git.FsClient,
  http,
  dir: "/",
  remote: "origin",
  ref: project.origin.branch,
  singleBranch: true,
  depth: 50,                                  // was: 1
  corsProxy: GIT_CORS_PROXY,
  headers: { Authorization: authHeader },
  onAuth: () => ({ username: "oauth2", password: session.gitlabToken }),
  onAuthFailure: () => {
    console.error("[sync] auth rejected by remote")
    return { cancel: true }
  },
})
```

- [ ] **Step 11.3: Add the merge-and-push branch**

Find the `if (remoteHead !== project.origin.headSha)` block (currently ~line 96 after Phase 2). Replace that block's body (the one that returns `remote-moved`) with a flag so we know to merge *after* Phase 2's serialize-and-commit step:

```ts
const remoteHead = await git.resolveRef({
  fs: fs as unknown as git.FsClient,
  dir: "/",
  ref: `refs/remotes/origin/${project.origin.branch}`,
})

const remoteMoved = remoteHead !== project.origin.headSha
```

Move the existing `if (remoteHead !== project.origin.headSha)` return OUT of the fetch try-block. We still do the serialize+commit step (Phase 2) first, then decide whether to push or merge.

Inside the serialize+commit+push block, right BEFORE the existing `git.push`, insert:

```ts
// Phase 3 — merge if remote moved during or before this sync.
let mergeSha: string | undefined
let touchedPaths: string[] = []
if (remoteMoved) {
  onPhase?.("merging")
  try {
    const { mergeRemoteIntoOurs, MergeFailure } = await import("./git-merge")
    const result = await mergeRemoteIntoOurs({
      fs, dir: "/",
      oursSha: commitSha,
      theirsSha: remoteHead,
      author: { name: session.username, email: `${session.username}@frontier` },
    })
    mergeSha = result.mergeSha
    touchedPaths = result.touchedPaths
  } catch (e) {
    if (e && typeof e === "object" && (e as { name?: string }).name === "MergeFailure") {
      const mf = e as { message: string; backupRef?: string }
      return { status: "error", message: mf.message, backupRef: mf.backupRef }
    }
    throw e
  }
}
```

Then push (unchanged), then after push completes add rehydrate step:

```ts
// After successful push:
if (touchedPaths.length > 0) {
  onPhase?.("rehydrating")
  const { parseCodexNotebook } = await import("@/lib/codex-editor/parse-codex")
  const { rehydrateFileDoc } = await import("@/lib/store/file-doc")
  const syncedAt = Date.now()
  for (const relpath of touchedPaths) {
    if (!relpath.endsWith(".codex") && !relpath.endsWith(".source")) continue
    // Find the file reference whose on-disk path ends with this relpath.
    const fullPath = "/" + relpath
    const match = fileHandles.find(h => {
      const p = findOriginalPath(project, h.ref.name)
      return p === fullPath
    })
    if (!match) continue
    const bytes = await fs.promises.readFile(fullPath, { encoding: "utf8" }) as string
    const merged = parseCodexNotebook(bytes)
    rehydrateFileDoc(match.handle.doc, merged, syncedAt)
  }
}

// Final origin.headSha update: if we merged, use mergeSha; else commitSha.
const finalSha = mergeSha ?? commitSha
const updated: ProjectRecord = {
  ...project,
  origin: { ...project.origin, headSha: finalSha },
}
await updateProject(updated)

onPhase?.("done")
return mergeSha
  ? { status: "merged", commitSha: finalSha, mergeSha, touchedPaths, filesWritten }
  : { status: "synced", commitSha: finalSha, filesWritten }
```

- [ ] **Step 11.4: Write an integration test for the divergent-merge path**

Append to `src/lib/sync/git-sync.test.ts`:

```ts
// (continues the existing describe block)

it("merges + pushes when remote moved since last sync", async () => {
  // This test uses the existing Phase 2 test fixture pattern. Reproduce it
  // inside two in-memory repos that share a history, mutate each, then
  // invoke syncProject on "ours" and verify the remote ends up with a
  // two-parent merge commit.
  //
  // If the project doesn't already have a "remote repo" fixture, stub it:
  // create a second MemoryDirectoryHandle-backed bare repo and configure
  // the ours' fs to have refs/remotes/origin/<branch> pointing at its tip.
  //
  // Steps (pseudo — expand as needed for your fixture layout):
  //   1. Build a base .codex, clone it into ours + theirs in-memory.
  //   2. On theirs, edit cell c1 (ts=100) and "push" (copy commit to remote).
  //   3. On ours, edit cell c1 (ts=50) via Y.Doc and write its persistence.
  //   4. Call syncProject(ours, session, { fs: oursFs }) — should merge.
  //   5. Assert result.status === "merged" and result.mergeSha is defined.
  //   6. Read back the merged commit on origin, verify cell.edits has both.
  //
  // If the fixture API isn't there yet, create the minimal helper
  // `src/test/git-repo-fixture.ts` that returns { fs, origin, pushToOrigin }.
})
```

(Full fixture is fleshed out in Task 14; for now, leaving this test as a placeholder is acceptable for the intermediate commit. Mark it `.skip` if needed.)

- [ ] **Step 11.5: Run existing sync tests to verify nothing regressed**

Run: `npx vitest run src/lib/sync/git-sync.test.ts`
Expected: existing tests still pass; new merge test may be skipped.

- [ ] **Step 11.6: Run `tsc -b` to catch type errors**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 11.7: Commit**

```bash
git add src/lib/sync/git-sync.ts src/lib/sync/git-sync.test.ts
git commit -m "feat(m13.3): wire mergeRemoteIntoOurs + rehydrate into syncProject"
```

---

## Task 12: UI — syncing context + freeze overlay + SyncButton update

Freeze cell input during sync so live Yjs edits don't collide with rehydration. SyncButton changes its label when remote-moved → "Merge & push".

**Files:**
- Create: `src/context/SyncingContext.tsx`
- Modify: `src/hooks/useSyncProject.ts` (publish `inFlight` to the context)
- Modify: `src/components/SyncButton.tsx` (re-enable action during remote-moved)
- Modify: `src/components/editor/CodexCellEditor.tsx` (consume context, short-circuit)

- [ ] **Step 12.1: Create `SyncingContext.tsx`**

```tsx
// src/context/SyncingContext.tsx
import { createContext, useContext, useMemo, useState, type ReactNode } from "react"

interface SyncingState {
  syncing: boolean
  setSyncing: (v: boolean) => void
}

const Ctx = createContext<SyncingState>({ syncing: false, setSyncing: () => {} })

export function SyncingProvider({ children }: { children: ReactNode }) {
  const [syncing, setSyncing] = useState(false)
  const value = useMemo(() => ({ syncing, setSyncing }), [syncing])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSyncing(): SyncingState {
  return useContext(Ctx)
}
```

- [ ] **Step 12.2: Wire the provider into the app root**

Find the main `App.tsx` or similar root component (run `grep -l "BrowserRouter\|RouterProvider" src/`). Wrap children in `<SyncingProvider>`.

```tsx
import { SyncingProvider } from "@/context/SyncingContext"

// ...inside the JSX tree, as high as reasonable:
<SyncingProvider>{existingChildren}</SyncingProvider>
```

- [ ] **Step 12.3: Publish inFlight from `useSyncProject`**

Edit `src/hooks/useSyncProject.ts` — add the context hook and mirror `inFlight`:

```ts
import { useState, useCallback, useEffect } from "react"
import { syncProject, type SyncPhase, type SyncResult } from "@/lib/sync/git-sync"
import { useSyncing } from "@/context/SyncingContext"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"

interface State {
  phase: SyncPhase
  inFlight: boolean
  lastResult: SyncResult | null
}

export function useSyncProject() {
  const [state, setState] = useState<State>({ phase: "idle", inFlight: false, lastResult: null })
  const { setSyncing } = useSyncing()

  useEffect(() => { setSyncing(state.inFlight) }, [state.inFlight, setSyncing])

  const sync = useCallback(
    async (project: ProjectRecord, session: FrontierSession): Promise<SyncResult | null> => {
      let alreadyInFlight = false
      setState((s) => {
        if (s.inFlight) { alreadyInFlight = true; return s }
        return { ...s, inFlight: true, phase: "checking-dirty" }
      })
      if (alreadyInFlight) return null

      const result = await syncProject(project, session, {
        onPhase: (phase) => setState((s) => ({ ...s, phase })),
      })
      setState({
        phase:
          result.status === "synced" || result.status === "merged"
            ? "done"
            : result.status === "no-changes"
              ? "idle"
              : result.status === "remote-moved"
                ? "remote-moved"
                : "error",
        inFlight: false,
        lastResult: result,
      })
      return result
    },
    [],
  )

  return { ...state, sync }
}
```

- [ ] **Step 12.4: Consume `useSyncing` in `CodexCellEditor`**

Find the cell editor file — run `grep -rn "onChange" src/components/editor/ | head -5`. In the primary Y.Text binding's `onChange` (or the wrapping component), early-return when `syncing`:

```tsx
import { useSyncing } from "@/context/SyncingContext"

// Inside the editor component:
const { syncing } = useSyncing()

// In each onChange handler that writes to Y.Doc:
if (syncing) return
```

Also add a small visual overlay at the top of the editor pane when `syncing` is true:

```tsx
{syncing && (
  <div className="px-3 py-1 text-xs bg-amber-50 text-amber-800 border-b border-amber-200">
    Merging incoming changes…
  </div>
)}
```

- [ ] **Step 12.5: Update `SyncButton.tsx` to act on remote-moved**

Edit `src/components/SyncButton.tsx` — remove any disabled state or "requires Phase 3" label tied to `remote-moved` status, and make the button available always when the user can push. Label the button "Merge & push" when `lastResult.status === "remote-moved"`, otherwise "Sync".

```tsx
const label =
  state.inFlight
    ? phaseLabel(state.phase)    // existing helper; add "merging", "rehydrating" labels
    : state.lastResult?.status === "remote-moved"
      ? "Merge & push"
      : "Sync"
```

Where `phaseLabel` is extended:

```ts
function phaseLabel(p: SyncPhase): string {
  switch (p) {
    case "checking-dirty": return "Checking…"
    case "serializing": return "Serializing…"
    case "writing": return "Writing…"
    case "committing": return "Committing…"
    case "merging": return "Merging…"
    case "rehydrating": return "Rehydrating…"
    case "pushing": return "Pushing…"
    default: return "Sync"
  }
}
```

- [ ] **Step 12.6: Manual smoke test**

Run: `npm run dev`, open the app, import a git project, edit a cell, modify the same project from another tab / desktop app, hit Sync in the first tab. Verify:
- Button label is "Merge & push" when remote-moved.
- The amber "Merging incoming changes…" banner appears briefly.
- After sync the cell shows the merged value and edit history.

(If dev server unavailable in your environment, skip and commit — integration test in Task 14 covers it.)

- [ ] **Step 12.7: Commit**

```bash
git add src/context/SyncingContext.tsx \
        src/hooks/useSyncProject.ts \
        src/components/SyncButton.tsx \
        src/components/editor/CodexCellEditor.tsx \
        $(grep -l "SyncingProvider" src/ -r 2>/dev/null | grep -v SyncingContext || true)
git commit -m "feat(m13.3): freeze editor input during sync + SyncButton merge action"
```

---

## Task 13: End-to-end integration test

Two-user scenario simulated over in-memory git. Verifies the complete Phase 2 + Phase 3 pipeline including rehydration.

**Files:**
- Create: `src/lib/sync/git-merge/__test__/git-merge.integration.test.ts`
- Create (if not present): `src/test/git-repo-fixture.ts`

- [ ] **Step 13.1: Create the two-user fixture**

```ts
// src/test/git-repo-fixture.ts
// Lightweight helpers for two-user integration testing over MemoryFs.
import * as git from "isomorphic-git"
import { createMemoryFs } from "@/test/opfs-fixture"
import type { OpfsFs } from "@/lib/git/opfs-fs"

export interface Repo { fs: OpfsFs; dir: string }

export async function makeRepo(): Promise<Repo> {
  const fs = createMemoryFs()
  await git.init({ fs: fs as unknown as git.FsClient, dir: "/" })
  return { fs, dir: "/" }
}

/** Copy every object and ref from src into dst, simulating a push/fetch. */
export async function copyRepo(src: Repo, dst: Repo): Promise<void> {
  const srcFs = src.fs as unknown as git.FsClient
  const dstFs = dst.fs as unknown as git.FsClient

  // Copy .git directory contents path-by-path using the fs promises shim.
  async function walk(path: string): Promise<string[]> {
    const out: string[] = []
    const entries = await src.fs.promises.readdir(path)
    for (const name of entries) {
      const child = path === "/" ? `/${name}` : `${path}/${name}`
      try {
        const stat = await src.fs.promises.stat(child)
        if (stat.isDirectory()) out.push(...(await walk(child)))
        else out.push(child)
      } catch { /* ignore missing */ }
    }
    return out
  }

  const allFiles = await walk("/.git")
  for (const f of allFiles) {
    const content = await src.fs.promises.readFile(f)
    // Make parent dirs on dst via writeFile (OpfsFs auto-creates).
    await dst.fs.promises.writeFile(f, content)
  }
  void srcFs; void dstFs
}
```

Adapt as needed — if your existing Phase 2 tests already have a similar helper, reuse it.

- [ ] **Step 13.2: Write the integration test**

```ts
// src/lib/sync/git-merge/__test__/git-merge.integration.test.ts
import { describe, it, expect } from "vitest"
import * as git from "isomorphic-git"
import { makeRepo, copyRepo } from "@/test/git-repo-fixture"
import { mergeRemoteIntoOurs } from "../index"

function cell(id: string, value: string, edits: unknown[] = []) {
  return { kind: 2, languageId: "html", value, metadata: { id, type: "text", edits } }
}

function nb(cells: ReturnType<typeof cell>[]) {
  return JSON.stringify({ cells, metadata: { id: "f", originalName: "f" } })
}

describe("two-user merge integration", () => {
  it("preserves both users' edits across a merge", async () => {
    // 1. Base state in a shared "remote" repo.
    const remote = await makeRepo()
    await remote.fs.promises.writeFile("/files/target/f.codex", nb([cell("c1", "base")]))
    await git.add({ fs: remote.fs as unknown as git.FsClient, dir: "/", filepath: "files/target/f.codex" })
    const baseSha = await git.commit({
      fs: remote.fs as unknown as git.FsClient, dir: "/",
      author: { name: "u", email: "u@u" }, message: "base",
    })

    // 2. Clone into user A.
    const alice = await makeRepo()
    await copyRepo(remote, alice)
    // Set HEAD to remote's tip.
    await alice.fs.promises.writeFile("/.git/HEAD", `ref: refs/heads/main\n`)
    await alice.fs.promises.writeFile("/.git/refs/heads/main", baseSha)

    // 3. User A edits c1 with ts=10.
    await alice.fs.promises.writeFile("/files/target/f.codex", nb([
      cell("c1", "alice-edit", [
        { editMap: ["value"], value: "alice-edit", timestamp: 10, author: "alice", type: "user-edit" },
      ]),
    ]))
    await git.add({ fs: alice.fs as unknown as git.FsClient, dir: "/", filepath: "files/target/f.codex" })
    const aliceSha = await git.commit({
      fs: alice.fs as unknown as git.FsClient, dir: "/",
      author: { name: "alice", email: "alice@a" }, message: "alice edit", parent: [baseSha],
    })

    // 4. User B starts from base, edits c1 with ts=20, pushes to remote.
    const bob = await makeRepo()
    await copyRepo(remote, bob)
    await bob.fs.promises.writeFile("/.git/HEAD", `ref: refs/heads/main\n`)
    await bob.fs.promises.writeFile("/.git/refs/heads/main", baseSha)
    await bob.fs.promises.writeFile("/files/target/f.codex", nb([
      cell("c1", "bob-edit", [
        { editMap: ["value"], value: "bob-edit", timestamp: 20, author: "bob", type: "user-edit" },
      ]),
    ]))
    await git.add({ fs: bob.fs as unknown as git.FsClient, dir: "/", filepath: "files/target/f.codex" })
    const bobSha = await git.commit({
      fs: bob.fs as unknown as git.FsClient, dir: "/",
      author: { name: "bob", email: "bob@b" }, message: "bob edit", parent: [baseSha],
    })
    await copyRepo(bob, remote)
    await remote.fs.promises.writeFile("/.git/refs/heads/main", bobSha)

    // 5. Alice fetches bob's tip into her repo + merges.
    await copyRepo(remote, alice)
    // Simulate fetch: put refs/remotes/origin/main at bobSha.
    await alice.fs.promises.writeFile("/.git/refs/remotes/origin/main", bobSha)

    const { mergeSha } = await mergeRemoteIntoOurs({
      fs: alice.fs, dir: "/",
      oursSha: aliceSha, theirsSha: bobSha,
      author: { name: "alice", email: "alice@a" },
    })

    // 6. Verify merged file has both edits.
    const merge = await git.readCommit({ fs: alice.fs as unknown as git.FsClient, dir: "/", oid: mergeSha })
    const { blob } = await git.readBlob({
      fs: alice.fs as unknown as git.FsClient, dir: "/",
      oid: merge.commit.tree, filepath: "files/target/f.codex",
    })
    const parsed = JSON.parse(new TextDecoder().decode(blob))
    const values = parsed.cells[0].metadata.edits.map((e: { value: string }) => e.value).sort()
    expect(values).toEqual(["alice-edit", "bob-edit"])
    expect(parsed.cells[0].value).toBe("bob-edit") // latest ts wins
    expect(merge.commit.parent).toEqual([aliceSha, bobSha])
  })
})
```

- [ ] **Step 13.3: Run integration test**

Run: `npx vitest run src/lib/sync/git-merge/__test__/git-merge.integration.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 13.4: Run the full test suite one last time**

Run: `npx vitest run`
Expected: all existing tests + Phase 3 tests pass.

- [ ] **Step 13.5: Run `tsc -b`**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 13.6: Final commit**

```bash
git add src/test/git-repo-fixture.ts \
        src/lib/sync/git-merge/__test__/git-merge.integration.test.ts
git commit -m "test(m13.3): two-user merge preserves both users' edits end-to-end"
```

---

## Self-review checklist (run once before handing off)

- [ ] **Spec coverage:** Every numbered step in the spec's "High-level flow" has a task (Task 1-11). Freeze UX → Task 12. Failure path / backup ref → Task 9. Rehydration → Task 10. Tree walk → Task 7. Tree write → Task 8. Per-path resolvers → Tasks 2-6. Tests → all tasks (unit) + Task 13 (integration).
- [ ] **Placeholder scan:** No "TBD", "TODO" in code blocks; Task 11.4 test is explicitly marked as placeholder with instructions to expand or `.skip`, resolved by Task 13's full fixture.
- [ ] **Type consistency:** `editKey` formula identical across `resolveCodex.ts` and `resolveMetadata.ts`. `DiffEntry.kind` values `"both-differ" | "ours-only" | "theirs-only"` used consistently in Tasks 7-9. `MergeResult.touchedPaths` used in `syncProject` wire-up (Task 11).
- [ ] **Exports:** Each new module's `export` list is reachable via the barrel index added in Tasks 2.5, 3.4, 4.4, 5.4, 6.4.

---

## Plan-end push

- [ ] **Push the completed branch**

Run: `git push`
Expected: all Phase 3 commits land on `feat/m13-phase1-git-import` (or a new `feat/m13-phase3-git-merge` if the branch was opened per plan).

- [ ] **Open PR when ready** — separate step; ask the user first.
