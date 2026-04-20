# Validation History on Yjs-Native Edits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move cell edits and validations into a live `cell.edits` Y.Array so the Yjs doc is the sole source of truth; `__source` becomes read-only import data + lazy GitLab-export artifact.

**Architecture:** New `cell.edits: Y.Array<Y.Map>` with session-grouped entries (5-min window, same author+type+editMap). Each value-editMap entry carries a `validatedBy: Y.Map<username, Y.Map>` for CRDT-natural dedup. Read path (`useCells`) walks `cell.edits`; serialize path emits the legacy `EditHistory[]` shape from `cell.edits`. Rehydrate wipes+rebuilds `cell.edits` from merged `__source.metadata.edits` on every run (matches existing `cell.history` behavior — see deviation note below).

**Tech Stack:** TypeScript, Yjs, Vitest, React, TipTap.

**Spec:** `docs/superpowers/specs/2026-04-20-validation-history-design.md` (commit c944724).

**Deviation from spec — rehydrate strategy:** The spec proposes a `__editsSeeded` marker to run seeding once. This has a latent bug: when GitLab pulls introduce new edits into `__source.metadata.edits`, the marker would prevent them from reaching `cell.edits`. This plan replaces the marker with wipe+rebuild on every rehydrate, matching existing `cell.history` behavior (`src/lib/store/file-doc.ts:297-307`). Local unsynced edits between a last-push and a subsequent pull are lost — same limitation that exists today for `cell.history`. Addressing that limitation is out of scope here.

---

## File Structure

**New files (under `src/lib/codex-editor/edits/`):**
- `types.ts` — plain-JS projections: `EditSessionSnapshot`, `EditValidationSummary`, constants
- `yjs-helpers.ts` — create-entry, create-validator-map, upsert-validator, soft-delete-validator, snapshot-entry → plain object
- `commit-cell-edit.ts` — `commitCellEdit()` session-grouping write
- `toggle-cell-validation.ts` — `toggleCellValidation()` on `cell.edits`
- `commit-meta-edit.ts` — `commitMetaEdit()` for notebook-level edits
- `seed-from-source.ts` — `seedCellEditsFromSource()`, `seedMetaEditsFromSource()`

**Test files (colocated):**
- `yjs-helpers.test.ts`
- `commit-cell-edit.test.ts`
- `toggle-cell-validation.test.ts`
- `commit-meta-edit.test.ts`
- `seed-from-source.test.ts`

**Modified files:**
- `src/hooks/useCells.ts` — read from `cell.edits`; add `validationHistory` to `CellData`
- `src/hooks/useCellHistory.ts` — delegate `toggleCellValidation` to edits module; remove `updateSourceValidation`; keep `appendCellHistory`/`recordHistoryEntry` unchanged
- `src/lib/store/file-doc.ts` — call seeders in `rehydrateFileDoc`
- `src/lib/codex-editor/serialize/cell.ts` — emit `metadata.edits` from `cell.edits`
- `src/lib/codex-editor/serialize/file.ts` — emit `meta.edits` from `meta.edits` Y.Array
- `src/components/EditorTable.tsx` — call `commitCellEdit` alongside `recordHistoryEntry`; swap "others" icon; expand popover with history timeline

---

## Task 0: Setup worktree

**Files:** N/A (git worktree creation).

- [ ] **Step 1: Create isolated worktree**

Run:
```bash
cd /Users/ryderwishart/prototypes/codex-web-app
git worktree add -b feat/validation-history .worktrees/validation-history main
cd .worktrees/validation-history
```

Expected: new branch `feat/validation-history` off main; worktree at `.worktrees/validation-history`.

- [ ] **Step 2: Verify clean worktree**

Run: `git status`
Expected: `On branch feat/validation-history` and `nothing to commit, working tree clean`.

- [ ] **Step 3: Install dependencies (if needed)**

Run: `npm install`
Expected: no errors; `node_modules/` ready.

- [ ] **Step 4: Baseline test run**

Run: `npm test -- --reporter=default 2>&1 | tail -20`
Expected: all existing tests pass. Record the pass count — this is the pre-change baseline.

---

## Task 1: Edit types and constants

**Files:**
- Create: `src/lib/codex-editor/edits/types.ts`

- [ ] **Step 1: Create the types module**

Create `src/lib/codex-editor/edits/types.ts`:

```typescript
import type { EditTypeValue, ValidationEntry } from "@/lib/codex-editor/types"

/**
 * Contiguous-commit window. A commit from the same author+type+editMap
 * within this many ms of the last entry extends that entry in place.
 * Must match the desktop serializer's SESSION_GAP_MS in
 * src/lib/codex-editor/serialize/edit-sessions.ts so round-trips are stable.
 */
export const SESSION_GAP_MS = 5 * 60_000

/**
 * Plain-JS projection of a `cell.edits` entry for UI consumption. Produced by
 * snapshotEntry() in yjs-helpers.ts. The live Y.Map is the source of truth;
 * this is a detached read-only copy.
 */
export interface EditSessionSnapshot {
  authors: string[]
  timestamp: number
  type: EditTypeValue
  editMap: string[]
  value: unknown
  validatedBy: ValidationEntry[]
}

/**
 * Per-edit summary used by the validation popover timeline in EditorTable.
 * Active = isDeleted=false; all includes soft-deleted entries for the
 * expanded-row view.
 */
export interface EditValidationSummary {
  authors: string[]
  timestamp: number
  type: EditTypeValue
  editMap: string[]
  value: unknown
  validatorsActive: string[]
  validatorsAll: ValidationEntry[]
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/codex-editor/edits/types.ts
git commit -m "feat(edits): add EditSessionSnapshot and EditValidationSummary types"
```

---

## Task 2: Yjs helpers — building blocks

**Files:**
- Create: `src/lib/codex-editor/edits/yjs-helpers.ts`
- Create: `src/lib/codex-editor/edits/yjs-helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/codex-editor/edits/yjs-helpers.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import {
  getEditsArray,
  createEntry,
  snapshotEntry,
  upsertValidator,
  softDeleteValidator,
  getValidatorsActive,
} from "./yjs-helpers"

function newCell(): Y.Map<unknown> {
  const doc = new Y.Doc()
  const cell = new Y.Map<unknown>()
  doc.getMap("cells").set("c1", cell)
  return cell
}

describe("yjs-helpers", () => {
  it("creates an edits Y.Array on first access and reuses it on second", () => {
    const cell = newCell()
    const a = getEditsArray(cell)
    const b = getEditsArray(cell)
    expect(a).toBe(b)
  })

  it("createEntry builds a Y.Map with the expected shape", () => {
    const cell = newCell()
    const entry = createEntry({
      authors: ["alice"],
      timestamp: 1000,
      type: "user-edit",
      editMap: ["value"],
      value: "hello",
      seedValidator: "alice",
    })
    const snap = snapshotEntry(entry)
    expect(snap.authors).toEqual(["alice"])
    expect(snap.timestamp).toBe(1000)
    expect(snap.type).toBe("user-edit")
    expect(snap.editMap).toEqual(["value"])
    expect(snap.value).toBe("hello")
    expect(snap.validatedBy).toEqual([
      { username: "alice", creationTimestamp: 1000, updatedTimestamp: 1000, isDeleted: false },
    ])
    void cell
  })

  it("createEntry omits validatedBy when seedValidator is undefined", () => {
    const entry = createEntry({
      authors: ["alice"],
      timestamp: 1000,
      type: "llm-edit",
      editMap: ["value"],
      value: "hi",
    })
    const snap = snapshotEntry(entry)
    expect(snap.validatedBy).toEqual([])
  })

  it("upsertValidator adds a new username keyed entry", () => {
    const entry = createEntry({
      authors: ["alice"],
      timestamp: 1000,
      type: "user-edit",
      editMap: ["value"],
      value: "hi",
      seedValidator: "alice",
    })
    upsertValidator(entry, "bob", 2000)
    expect(getValidatorsActive(entry)).toEqual(["alice", "bob"])
  })

  it("upsertValidator re-activates a soft-deleted validator", () => {
    const entry = createEntry({
      authors: ["alice"],
      timestamp: 1000,
      type: "user-edit",
      editMap: ["value"],
      value: "hi",
      seedValidator: "alice",
    })
    softDeleteValidator(entry, "alice", 2000)
    expect(getValidatorsActive(entry)).toEqual([])
    upsertValidator(entry, "alice", 3000)
    expect(getValidatorsActive(entry)).toEqual(["alice"])
    const snap = snapshotEntry(entry)
    const alice = snap.validatedBy.find(v => v.username === "alice")!
    expect(alice.creationTimestamp).toBe(1000)
    expect(alice.updatedTimestamp).toBe(3000)
    expect(alice.isDeleted).toBe(false)
  })

  it("softDeleteValidator on a missing username is a no-op", () => {
    const entry = createEntry({
      authors: ["alice"],
      timestamp: 1000,
      type: "user-edit",
      editMap: ["value"],
      value: "hi",
    })
    softDeleteValidator(entry, "zoe", 2000)
    expect(getValidatorsActive(entry)).toEqual([])
    expect(snapshotEntry(entry).validatedBy).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/codex-editor/edits/yjs-helpers.test.ts 2>&1 | tail -15`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement yjs-helpers**

Create `src/lib/codex-editor/edits/yjs-helpers.ts`:

```typescript
import * as Y from "yjs"
import type { EditTypeValue, ValidationEntry } from "@/lib/codex-editor/types"
import type { EditSessionSnapshot } from "./types"

/**
 * Canonical getter for a cell's edits array. Creates on first access so
 * callers never have to null-check. The returned Y.Array holds Y.Map entries
 * shaped per createEntry() below.
 */
export function getEditsArray(cell: Y.Map<unknown>): Y.Array<Y.Map<unknown>> {
  let arr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
  if (!arr) {
    arr = new Y.Array<Y.Map<unknown>>()
    cell.set("edits", arr)
  }
  return arr
}

export interface CreateEntryInput {
  authors: string[]
  timestamp: number
  type: EditTypeValue
  editMap: string[]
  value: unknown
  /** If set, seeds validatedBy with an active entry for this username. */
  seedValidator?: string
}

/**
 * Build a fresh Y.Map for a session entry. The returned Y.Map is detached —
 * caller is responsible for push()'ing it onto the cell.edits array. We only
 * create the validatedBy Y.Map when there's at least one validator (keeps
 * the serialized shape clean: omit validatedBy entirely when empty).
 */
export function createEntry(input: CreateEntryInput): Y.Map<unknown> {
  const entry = new Y.Map<unknown>()
  const authorsArr = new Y.Array<string>()
  authorsArr.push(input.authors.slice())
  entry.set("authors", authorsArr)
  entry.set("timestamp", input.timestamp)
  entry.set("type", input.type)
  const editMapArr = new Y.Array<string>()
  editMapArr.push(input.editMap.slice())
  entry.set("editMap", editMapArr)
  entry.set("value", input.value)
  if (input.seedValidator) {
    const validators = new Y.Map<Y.Map<unknown>>()
    const v = new Y.Map<unknown>()
    v.set("creationTimestamp", input.timestamp)
    v.set("updatedTimestamp", input.timestamp)
    v.set("isDeleted", false)
    validators.set(input.seedValidator, v)
    entry.set("validatedBy", validators)
  }
  return entry
}

/**
 * Project a live entry Y.Map into a detached plain object for reads. Missing
 * or malformed fields degrade to safe defaults so a half-populated entry
 * (e.g. mid-transaction observer firing) can still be rendered.
 */
export function snapshotEntry(entry: Y.Map<unknown>): EditSessionSnapshot {
  const authorsArr = entry.get("authors") as Y.Array<string> | undefined
  const editMapArr = entry.get("editMap") as Y.Array<string> | undefined
  const validators = entry.get("validatedBy") as Y.Map<Y.Map<unknown>> | undefined
  const validatedBy: ValidationEntry[] = []
  if (validators) {
    validators.forEach((v, username) => {
      validatedBy.push({
        username,
        creationTimestamp: (v.get("creationTimestamp") as number) ?? 0,
        updatedTimestamp: (v.get("updatedTimestamp") as number) ?? 0,
        isDeleted: !!v.get("isDeleted"),
      })
    })
  }
  validatedBy.sort((a, b) => a.username.localeCompare(b.username))
  return {
    authors: authorsArr ? authorsArr.toArray() : [],
    timestamp: (entry.get("timestamp") as number) ?? 0,
    type: (entry.get("type") as EditTypeValue) ?? "user-edit",
    editMap: editMapArr ? editMapArr.toArray() : [],
    value: entry.get("value"),
    validatedBy,
  }
}

/**
 * Add or reactivate a validator. Idempotent: calling twice for the same
 * username at the same timestamp produces the same state (last-write-wins on
 * updatedTimestamp is exactly what we want for concurrent same-user writes).
 */
export function upsertValidator(
  entry: Y.Map<unknown>, username: string, timestamp: number,
): void {
  let validators = entry.get("validatedBy") as Y.Map<Y.Map<unknown>> | undefined
  if (!validators) {
    validators = new Y.Map<Y.Map<unknown>>()
    entry.set("validatedBy", validators)
  }
  let v = validators.get(username)
  if (!v) {
    v = new Y.Map<unknown>()
    v.set("creationTimestamp", timestamp)
    validators.set(username, v)
  }
  v.set("updatedTimestamp", timestamp)
  v.set("isDeleted", false)
}

/**
 * Soft-delete a validator. No-op if the username isn't present — we don't
 * want to create a tombstone for someone who never validated.
 */
export function softDeleteValidator(
  entry: Y.Map<unknown>, username: string, timestamp: number,
): void {
  const validators = entry.get("validatedBy") as Y.Map<Y.Map<unknown>> | undefined
  if (!validators) return
  const v = validators.get(username)
  if (!v) return
  v.set("updatedTimestamp", timestamp)
  v.set("isDeleted", true)
}

/** Active (non-deleted) usernames in insertion order, for UI reads. */
export function getValidatorsActive(entry: Y.Map<unknown>): string[] {
  const validators = entry.get("validatedBy") as Y.Map<Y.Map<unknown>> | undefined
  if (!validators) return []
  const out: string[] = []
  validators.forEach((v, username) => {
    if (!v.get("isDeleted")) out.push(username)
  })
  return out
}

/** Does this entry's authors array contain the username? */
export function entryHasAuthor(entry: Y.Map<unknown>, username: string): boolean {
  const arr = entry.get("authors") as Y.Array<string> | undefined
  if (!arr) return false
  return arr.toArray().includes(username)
}

/** Append a new author to an entry's authors array. */
export function appendAuthor(entry: Y.Map<unknown>, username: string): void {
  let arr = entry.get("authors") as Y.Array<string> | undefined
  if (!arr) {
    arr = new Y.Array<string>()
    entry.set("authors", arr)
  }
  arr.push([username])
}

/** Deep-equal comparison for editMap arrays. */
export function editMapEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Read the editMap of a live entry as a plain string[]. */
export function getEntryEditMap(entry: Y.Map<unknown>): string[] {
  const arr = entry.get("editMap") as Y.Array<string> | undefined
  return arr ? arr.toArray() : []
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/codex-editor/edits/yjs-helpers.test.ts 2>&1 | tail -15`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/edits/yjs-helpers.ts src/lib/codex-editor/edits/yjs-helpers.test.ts
git commit -m "feat(edits): add Yjs helpers for cell.edits structure"
```

---

## Task 3: `commitCellEdit` — session-grouping write

**Files:**
- Create: `src/lib/codex-editor/edits/commit-cell-edit.ts`
- Create: `src/lib/codex-editor/edits/commit-cell-edit.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/codex-editor/edits/commit-cell-edit.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { commitCellEdit } from "./commit-cell-edit"
import { getEditsArray, snapshotEntry } from "./yjs-helpers"

function setupDoc() {
  const doc = new Y.Doc()
  const cell = new Y.Map<unknown>()
  doc.getMap("cells").set("c1", cell)
  return { doc, cell }
}

describe("commitCellEdit", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 3, 20, 10, 0, 0)) })
  afterEach(() => { vi.useRealTimers() })

  it("appends a new entry on the first commit", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(1)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.authors).toEqual(["alice"])
    expect(snap.value).toBe("hello")
    expect(snap.type).toBe("user-edit")
    expect(snap.validatedBy.map(v => v.username)).toEqual(["alice"])
  })

  it("updates the last entry in place for same author within 5 min", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(doc, "c1", "alice", ["value"], "hello world", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(1)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.value).toBe("hello world")
    expect(snap.authors).toEqual(["alice"])
  })

  it("appends a new entry when the gap exceeds 5 min", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
    vi.advanceTimersByTime(6 * 60_000)
    commitCellEdit(doc, "c1", "alice", ["value"], "later", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(2)
  })

  it("appends a new entry when the editMap differs", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(doc, "c1", "alice", ["metadata", "cellLabel"], "Gen 1:1", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(2)
  })

  it("appends a new entry when the type differs (human vs llm)", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(doc, "c1", "alice", ["value"], "ai-version", "llm")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(2)
    const snap2 = snapshotEntry(arr.get(1))
    expect(snap2.type).toBe("llm-edit")
    expect(snap2.validatedBy).toEqual([])
  })

  it("extends a same-window session with a second author and auto-validates them", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(doc, "c1", "bob", ["value"], "hi edited", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(1)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.authors).toEqual(["alice", "bob"])
    expect(snap.validatedBy.map(v => v.username).sort()).toEqual(["alice", "bob"])
  })

  it("LLM commit does not seed validatedBy", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "llm-bot", ["value"], "draft", "llm")
    const arr = getEditsArray(cell)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.authors).toEqual(["llm-bot"])
    expect(snap.validatedBy).toEqual([])
  })

  it("user commit after LLM entry appends a new entry and auto-validates the user", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "llm-bot", ["value"], "draft", "llm")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(doc, "c1", "alice", ["value"], "polished", "human")
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(2)
    const snap2 = snapshotEntry(arr.get(1))
    expect(snap2.authors).toEqual(["alice"])
    expect(snap2.validatedBy.map(v => v.username)).toEqual(["alice"])
  })

  it("no-op when cellId is missing", () => {
    const { doc } = setupDoc()
    expect(() => commitCellEdit(doc, "nonexistent", "alice", ["value"], "x", "human")).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/codex-editor/edits/commit-cell-edit.test.ts 2>&1 | tail -15`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement commitCellEdit**

Create `src/lib/codex-editor/edits/commit-cell-edit.ts`:

```typescript
import * as Y from "yjs"
import type { EditTypeValue } from "@/lib/codex-editor/types"
import { SESSION_GAP_MS } from "./types"
import {
  getEditsArray,
  createEntry,
  editMapEquals,
  getEntryEditMap,
  entryHasAuthor,
  appendAuthor,
  upsertValidator,
} from "./yjs-helpers"

function resolveType(source: "human" | "llm"): EditTypeValue {
  return source === "llm" ? "llm-edit" : "user-edit"
}

/**
 * Record a deliberate commit on a cell's value or metadata. Applies the
 * session-grouping rule: same author/type/editMap within SESSION_GAP_MS
 * extends the last entry in place; otherwise a new entry is appended.
 *
 * For source="human" on a value-editMap, the author is auto-validated.
 * LLM commits never auto-validate, and metadata-editMap entries omit
 * validatedBy entirely (file/project-level edits are audit-only per the
 * desktop app's FileEditHistory shape).
 *
 * Wrapped in doc.transact so observers fire once per commit.
 */
export function commitCellEdit(
  doc: Y.Doc,
  cellId: string,
  username: string,
  editMap: string[],
  value: unknown,
  source: "human" | "llm",
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  const type = resolveType(source)
  const isValueEdit = editMap[0] === "value"
  const now = Date.now()

  doc.transact(() => {
    const arr = getEditsArray(cell)
    const last = arr.length > 0 ? arr.get(arr.length - 1) : undefined

    if (last) {
      const lastTimestamp = (last.get("timestamp") as number) ?? 0
      const lastType = last.get("type") as EditTypeValue
      const lastEditMap = getEntryEditMap(last)
      const withinWindow = now - lastTimestamp < SESSION_GAP_MS
      const sameSession =
        withinWindow && lastType === type && editMapEquals(lastEditMap, editMap)

      if (sameSession) {
        last.set("value", value)
        last.set("timestamp", now)
        if (!entryHasAuthor(last, username)) appendAuthor(last, username)
        if (source === "human" && isValueEdit) upsertValidator(last, username, now)
        return
      }
    }

    const entry = createEntry({
      authors: [username],
      timestamp: now,
      type,
      editMap,
      value,
      seedValidator: source === "human" && isValueEdit ? username : undefined,
    })
    arr.push([entry])
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/codex-editor/edits/commit-cell-edit.test.ts 2>&1 | tail -15`
Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/edits/commit-cell-edit.ts src/lib/codex-editor/edits/commit-cell-edit.test.ts
git commit -m "feat(edits): add session-grouped commitCellEdit with auto-validation"
```

---

## Task 4: `toggleCellValidation` — on cell.edits

**Files:**
- Create: `src/lib/codex-editor/edits/toggle-cell-validation.ts`
- Create: `src/lib/codex-editor/edits/toggle-cell-validation.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/codex-editor/edits/toggle-cell-validation.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { commitCellEdit } from "./commit-cell-edit"
import { toggleCellValidation } from "./toggle-cell-validation"
import { getEditsArray, snapshotEntry } from "./yjs-helpers"

function setupDoc() {
  const doc = new Y.Doc()
  const cell = new Y.Map<unknown>()
  doc.getMap("cells").set("c1", cell)
  return { doc, cell }
}

describe("toggleCellValidation", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 3, 20, 10, 0, 0)) })
  afterEach(() => { vi.useRealTimers() })

  it("adds a second validator (bob) on alice's edit", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human")
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(doc, "c1", "bob", true)
    const snap = snapshotEntry(getEditsArray(cell).get(0))
    expect(snap.validatedBy.map(v => v.username).sort()).toEqual(["alice", "bob"])
  })

  it("soft-deletes a validator (isDeleted true, entry preserved)", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human")
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(doc, "c1", "alice", false)
    const snap = snapshotEntry(getEditsArray(cell).get(0))
    expect(snap.validatedBy).toHaveLength(1)
    expect(snap.validatedBy[0].isDeleted).toBe(true)
    expect(snap.validatedBy[0].updatedTimestamp).toBeGreaterThan(snap.validatedBy[0].creationTimestamp)
  })

  it("re-validates a soft-deleted validator (isDeleted false)", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human")
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(doc, "c1", "alice", false)
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(doc, "c1", "alice", true)
    const snap = snapshotEntry(getEditsArray(cell).get(0))
    expect(snap.validatedBy[0].isDeleted).toBe(false)
  })

  it("targets the latest value-edit, ignoring a later metadata-edit", () => {
    const { doc, cell } = setupDoc()
    commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human")
    vi.advanceTimersByTime(6 * 60_000)
    commitCellEdit(doc, "c1", "alice", ["metadata", "cellLabel"], "Gen 1:1", "human")
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(doc, "c1", "bob", true)
    const arr = getEditsArray(cell)
    const valueEntrySnap = snapshotEntry(arr.get(0))
    const metaEntrySnap = snapshotEntry(arr.get(1))
    expect(valueEntrySnap.validatedBy.map(v => v.username).sort()).toEqual(["alice", "bob"])
    expect(metaEntrySnap.validatedBy).toEqual([])
  })

  it("no-op when no value-edit exists", () => {
    const { doc } = setupDoc()
    toggleCellValidation(doc, "c1", "alice", true)
    // No throw, no state written.
    const cell = doc.getMap("cells").get("c1") as Y.Map<unknown>
    const arr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
    expect(arr?.length ?? 0).toBe(0)
  })

  it("no-op when cellId is missing", () => {
    const { doc } = setupDoc()
    expect(() => toggleCellValidation(doc, "nope", "alice", true)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/codex-editor/edits/toggle-cell-validation.test.ts 2>&1 | tail -15`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement toggleCellValidation**

Create `src/lib/codex-editor/edits/toggle-cell-validation.ts`:

```typescript
import * as Y from "yjs"
import {
  getEditsArray,
  getEntryEditMap,
  upsertValidator,
  softDeleteValidator,
} from "./yjs-helpers"

/**
 * Add or remove the current user's validation on the cell's latest
 * value-editMap entry. Only the most recent value-edit is togglable —
 * validations on prior states are historical and immutable.
 *
 * No-op if the cell has no value-edit yet (empty cell can't be validated).
 */
export function toggleCellValidation(
  doc: Y.Doc, cellId: string, username: string, validate: boolean,
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  doc.transact(() => {
    const arr = getEditsArray(cell)
    let target: Y.Map<unknown> | undefined
    for (let i = arr.length - 1; i >= 0; i--) {
      const entry = arr.get(i)
      if (getEntryEditMap(entry)[0] === "value") { target = entry; break }
    }
    if (!target) return
    const now = Date.now()
    if (validate) upsertValidator(target, username, now)
    else softDeleteValidator(target, username, now)
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/codex-editor/edits/toggle-cell-validation.test.ts 2>&1 | tail -15`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/edits/toggle-cell-validation.ts src/lib/codex-editor/edits/toggle-cell-validation.test.ts
git commit -m "feat(edits): add toggleCellValidation on cell.edits (soft-delete preserved)"
```

---

## Task 5: `commitMetaEdit` — file-level metadata edits

**Files:**
- Create: `src/lib/codex-editor/edits/commit-meta-edit.ts`
- Create: `src/lib/codex-editor/edits/commit-meta-edit.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/codex-editor/edits/commit-meta-edit.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { commitMetaEdit, getMetaEditsArray } from "./commit-meta-edit"
import { snapshotEntry } from "./yjs-helpers"

describe("commitMetaEdit", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 3, 20, 10, 0, 0)) })
  afterEach(() => { vi.useRealTimers() })

  it("appends a new entry and never seeds validatedBy (FileEditHistory shape)", () => {
    const doc = new Y.Doc()
    commitMetaEdit(doc, ["videoUrl"], "https://example.com/a.mp4", "alice", "human")
    const arr = getMetaEditsArray(doc.getMap("meta"))
    expect(arr.length).toBe(1)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.authors).toEqual(["alice"])
    expect(snap.editMap).toEqual(["videoUrl"])
    expect(snap.value).toBe("https://example.com/a.mp4")
    expect(snap.validatedBy).toEqual([])
  })

  it("extends the last entry in place for same-author within 5 min", () => {
    const doc = new Y.Doc()
    commitMetaEdit(doc, ["videoUrl"], "v1", "alice", "human")
    vi.advanceTimersByTime(60_000)
    commitMetaEdit(doc, ["videoUrl"], "v2", "alice", "human")
    const arr = getMetaEditsArray(doc.getMap("meta"))
    expect(arr.length).toBe(1)
    expect(snapshotEntry(arr.get(0)).value).toBe("v2")
  })

  it("appends a new entry when editMap differs", () => {
    const doc = new Y.Doc()
    commitMetaEdit(doc, ["videoUrl"], "v1", "alice", "human")
    vi.advanceTimersByTime(60_000)
    commitMetaEdit(doc, ["corpusMarker"], "OT", "alice", "human")
    const arr = getMetaEditsArray(doc.getMap("meta"))
    expect(arr.length).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/codex-editor/edits/commit-meta-edit.test.ts 2>&1 | tail -15`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement commitMetaEdit**

Create `src/lib/codex-editor/edits/commit-meta-edit.ts`:

```typescript
import * as Y from "yjs"
import type { EditTypeValue } from "@/lib/codex-editor/types"
import { SESSION_GAP_MS } from "./types"
import {
  createEntry, editMapEquals, getEntryEditMap,
  entryHasAuthor, appendAuthor,
} from "./yjs-helpers"

export function getMetaEditsArray(meta: Y.Map<unknown>): Y.Array<Y.Map<unknown>> {
  let arr = meta.get("edits") as Y.Array<Y.Map<unknown>> | undefined
  if (!arr) {
    arr = new Y.Array<Y.Map<unknown>>()
    meta.set("edits", arr)
  }
  return arr
}

function resolveType(source: "human" | "llm"): EditTypeValue {
  return source === "llm" ? "llm-edit" : "user-edit"
}

/**
 * Record a commit on a notebook-level metadata field. Session-grouping is
 * identical to commitCellEdit but we never seed validatedBy — notebook
 * metadata follows the desktop app's FileEditHistory shape (no validators).
 */
export function commitMetaEdit(
  doc: Y.Doc,
  editMap: string[],
  value: unknown,
  username: string,
  source: "human" | "llm",
): void {
  const meta = doc.getMap("meta")
  const type = resolveType(source)
  const now = Date.now()

  doc.transact(() => {
    const arr = getMetaEditsArray(meta)
    const last = arr.length > 0 ? arr.get(arr.length - 1) : undefined

    if (last) {
      const lastTs = (last.get("timestamp") as number) ?? 0
      const lastType = last.get("type") as EditTypeValue
      const lastEditMap = getEntryEditMap(last)
      if (now - lastTs < SESSION_GAP_MS && lastType === type && editMapEquals(lastEditMap, editMap)) {
        last.set("value", value)
        last.set("timestamp", now)
        if (!entryHasAuthor(last, username)) appendAuthor(last, username)
        return
      }
    }

    arr.push([createEntry({ authors: [username], timestamp: now, type, editMap, value })])
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/codex-editor/edits/commit-meta-edit.test.ts 2>&1 | tail -15`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/edits/commit-meta-edit.ts src/lib/codex-editor/edits/commit-meta-edit.test.ts
git commit -m "feat(edits): add commitMetaEdit for notebook-level metadata"
```

---

## Task 6: Seed from `__source` (migration, wipe+rebuild)

**Files:**
- Create: `src/lib/codex-editor/edits/seed-from-source.ts`
- Create: `src/lib/codex-editor/edits/seed-from-source.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/codex-editor/edits/seed-from-source.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import type { EditHistory, ValidationEntry } from "@/lib/codex-editor/types"
import { seedCellEditsFromSource, seedMetaEditsFromSource } from "./seed-from-source"
import { getEditsArray, snapshotEntry } from "./yjs-helpers"
import { getMetaEditsArray } from "./commit-meta-edit"

function makeCellWithSourceEdits(edits: EditHistory[]): { doc: Y.Doc; cell: Y.Map<unknown> } {
  const doc = new Y.Doc()
  const cell = new Y.Map<unknown>()
  cell.set("__source", {
    kind: 2,
    languageId: "html",
    value: "",
    metadata: { id: "c1", type: "text", edits },
  })
  doc.getMap("cells").set("c1", cell)
  return { doc, cell }
}

describe("seedCellEditsFromSource", () => {
  it("populates cell.edits from __source.metadata.edits", () => {
    const validated: ValidationEntry = { username: "alice", creationTimestamp: 1000, updatedTimestamp: 1000, isDeleted: false }
    const { doc, cell } = makeCellWithSourceEdits([
      { author: "alice", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "hi", validatedBy: [validated] },
    ])
    doc.transact(() => seedCellEditsFromSource(cell))
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(1)
    const snap = snapshotEntry(arr.get(0))
    expect(snap.authors).toEqual(["alice"])
    expect(snap.value).toBe("hi")
    expect(snap.validatedBy).toEqual([validated])
  })

  it("wipes existing cell.edits before seeding (idempotent + supports merge-pulls)", () => {
    const { doc, cell } = makeCellWithSourceEdits([
      { author: "alice", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "v1" },
    ])
    doc.transact(() => seedCellEditsFromSource(cell))
    expect(getEditsArray(cell).length).toBe(1)
    doc.transact(() => seedCellEditsFromSource(cell))
    expect(getEditsArray(cell).length).toBe(1)
  })

  it("splits multi-author 'alice/bob' back into an authors array", () => {
    const { doc, cell } = makeCellWithSourceEdits([
      { author: "alice/bob", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "hi" },
    ])
    doc.transact(() => seedCellEditsFromSource(cell))
    const snap = snapshotEntry(getEditsArray(cell).get(0))
    expect(snap.authors).toEqual(["alice", "bob"])
  })

  it("drops legacy string validatedBy entries", () => {
    const { doc, cell } = makeCellWithSourceEdits([
      { author: "alice", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "hi",
        validatedBy: ["bob" as unknown as ValidationEntry] },
    ])
    doc.transact(() => seedCellEditsFromSource(cell))
    const snap = snapshotEntry(getEditsArray(cell).get(0))
    expect(snap.validatedBy).toEqual([])
  })

  it("no-op when __source is missing", () => {
    const doc = new Y.Doc()
    const cell = new Y.Map<unknown>()
    doc.getMap("cells").set("c1", cell)
    expect(() => doc.transact(() => seedCellEditsFromSource(cell))).not.toThrow()
    expect(getEditsArray(cell).length).toBe(0)
  })
})

describe("seedMetaEditsFromSource", () => {
  it("populates meta.edits from __source.edits and never creates validatedBy", () => {
    const doc = new Y.Doc()
    const meta = doc.getMap("meta")
    meta.set("__source", { id: "n1", originalName: "n.codex",
      edits: [{ author: "alice", timestamp: 1000, type: "user-edit", editMap: ["videoUrl"], value: "url" }] })
    doc.transact(() => seedMetaEditsFromSource(meta))
    const arr = getMetaEditsArray(meta)
    expect(arr.length).toBe(1)
    expect(snapshotEntry(arr.get(0)).validatedBy).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/codex-editor/edits/seed-from-source.test.ts 2>&1 | tail -15`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement seeders**

Create `src/lib/codex-editor/edits/seed-from-source.ts`:

```typescript
import * as Y from "yjs"
import type { CodexCell, EditHistory, ValidationEntry } from "@/lib/codex-editor/types"
import { isValidValidationEntry } from "@/lib/codex-editor/merge/validators"
import { getEditsArray, createEntry, upsertValidator, softDeleteValidator } from "./yjs-helpers"
import { getMetaEditsArray } from "./commit-meta-edit"

/**
 * Split a serialized author string back into the canonical authors array.
 * Multi-author sessions emit "alice/bob" for back-compat with the desktop
 * EditHistory.author: string shape; the split is the reverse.
 */
function parseAuthors(author: string): string[] {
  if (!author) return []
  return author.split("/").map(a => a.trim()).filter(Boolean)
}

/**
 * Rebuild a cell's Y.Array<Y.Map> edits from the (post-merge) __source. Runs
 * inside the caller's transact(). Always wipes first so a GitLab merge that
 * introduces new edits propagates correctly. Matches existing file-doc
 * behavior where cell.history is similarly rebuilt on rehydrate.
 */
export function seedCellEditsFromSource(cell: Y.Map<unknown>): void {
  const source = cell.get("__source") as CodexCell | undefined
  if (!source) return
  const arr = getEditsArray(cell)
  if (arr.length > 0) arr.delete(0, arr.length)

  const edits = source.metadata?.edits ?? []
  for (const e of edits) {
    const authors = parseAuthors(e.author)
    if (authors.length === 0) continue
    const entry = createEntry({
      authors,
      timestamp: e.timestamp,
      type: e.type,
      editMap: e.editMap ?? [],
      value: e.value,
    })
    if (e.validatedBy && e.validatedBy.length > 0) {
      for (const raw of e.validatedBy as unknown[]) {
        if (!isValidValidationEntry(raw)) continue
        const v = raw as ValidationEntry
        upsertValidator(entry, v.username, v.creationTimestamp)
        if (v.updatedTimestamp > v.creationTimestamp) {
          if (v.isDeleted) softDeleteValidator(entry, v.username, v.updatedTimestamp)
          else upsertValidator(entry, v.username, v.updatedTimestamp)
        }
      }
    }
    arr.push([entry])
  }
}

interface MetaSource { edits?: EditHistory[] }

/**
 * Rebuild the notebook-level meta.edits Y.Array from __source.edits. Same
 * wipe+rebuild strategy as seedCellEditsFromSource. No validators — meta
 * edits follow the desktop FileEditHistory shape.
 */
export function seedMetaEditsFromSource(meta: Y.Map<unknown>): void {
  const source = meta.get("__source") as MetaSource | undefined
  if (!source) return
  const arr = getMetaEditsArray(meta)
  if (arr.length > 0) arr.delete(0, arr.length)
  const edits = source.edits ?? []
  for (const e of edits) {
    const authors = parseAuthors(e.author)
    if (authors.length === 0) continue
    const entry = createEntry({
      authors,
      timestamp: e.timestamp,
      type: e.type,
      editMap: e.editMap ?? [],
      value: e.value,
    })
    arr.push([entry])
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/codex-editor/edits/seed-from-source.test.ts 2>&1 | tail -15`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/edits/seed-from-source.ts src/lib/codex-editor/edits/seed-from-source.test.ts
git commit -m "feat(edits): seed cell.edits and meta.edits from __source on rehydrate"
```

---

## Task 7: Wire seeders into `rehydrateFileDoc`

**Files:**
- Modify: `src/lib/store/file-doc.ts`

- [ ] **Step 1: Read current rehydrate implementation**

Skim `src/lib/store/file-doc.ts:257-317` to confirm the structure.

- [ ] **Step 2: Add seeder imports and calls**

In `src/lib/store/file-doc.ts`, add to the existing import block near the top:

```typescript
import { seedCellEditsFromSource, seedMetaEditsFromSource } from "@/lib/codex-editor/edits/seed-from-source"
```

Then in `rehydrateFileDoc`, inside the `doc.transact` block, after `yCell.set("__source", JSON.parse(JSON.stringify(cell)))` (line 283) and before `// Refresh the translatedXml fragment`, add:

```typescript
      // Rebuild cell.edits from the merged __source so the Yjs-native edit
      // log stays in sync with disk state. Wipes existing entries; see
      // docs/superpowers/plans/2026-04-20-validation-history.md for why
      // a marker-based approach would lose GitLab-pulled edits.
      seedCellEditsFromSource(yCell)
```

And after `meta.set("__source", merged.metadata)` (line 315), still inside the transact, add:

```typescript
    seedMetaEditsFromSource(meta)
```

- [ ] **Step 3: Add an integration test for rehydrate**

Open `src/lib/store/file-doc.rehydrate.test.ts` and append this test near the existing test blocks (do not replace the existing ones):

```typescript
import { getEditsArray, snapshotEntry } from "@/lib/codex-editor/edits/yjs-helpers"
import { getMetaEditsArray } from "@/lib/codex-editor/edits/commit-meta-edit"

describe("rehydrateFileDoc — seeds cell.edits and meta.edits", () => {
  it("populates cell.edits from merged __source.metadata.edits", () => {
    const doc = new Y.Doc()
    const merged = {
      cells: [{
        kind: 2 as const, languageId: "html", value: "hello",
        metadata: { id: "c1", type: "text" as const, edits: [
          { author: "alice", timestamp: 1000, type: "user-edit" as const, editMap: ["value"], value: "hello",
            validatedBy: [{ username: "alice", creationTimestamp: 1000, updatedTimestamp: 1000, isDeleted: false }] },
        ] },
      }],
      metadata: { id: "n1", originalName: "n.codex" },
    }
    rehydrateFileDoc(doc, merged as never, 2000)
    const cell = doc.getMap("cells").get("c1") as Y.Map<unknown>
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(1)
    expect(snapshotEntry(arr.get(0)).authors).toEqual(["alice"])
  })

  it("wipes and rebuilds cell.edits on subsequent rehydrate (GitLab pull path)", () => {
    const doc = new Y.Doc()
    const first = {
      cells: [{ kind: 2 as const, languageId: "html", value: "v1",
        metadata: { id: "c1", type: "text" as const, edits: [
          { author: "alice", timestamp: 1000, type: "user-edit" as const, editMap: ["value"], value: "v1" },
        ] } }],
      metadata: { id: "n1", originalName: "n.codex" },
    }
    rehydrateFileDoc(doc, first as never, 2000)

    const second = {
      cells: [{ kind: 2 as const, languageId: "html", value: "v2",
        metadata: { id: "c1", type: "text" as const, edits: [
          { author: "alice", timestamp: 1000, type: "user-edit" as const, editMap: ["value"], value: "v1" },
          { author: "bob", timestamp: 4000, type: "user-edit" as const, editMap: ["value"], value: "v2" },
        ] } }],
      metadata: { id: "n1", originalName: "n.codex" },
    }
    rehydrateFileDoc(doc, second as never, 5000)

    const cell = doc.getMap("cells").get("c1") as Y.Map<unknown>
    const arr = getEditsArray(cell)
    expect(arr.length).toBe(2)
    expect(snapshotEntry(arr.get(1)).authors).toEqual(["bob"])
  })

  it("populates meta.edits from merged __source.edits", () => {
    const doc = new Y.Doc()
    const merged = {
      cells: [],
      metadata: { id: "n1", originalName: "n.codex",
        edits: [{ author: "alice", timestamp: 1000, type: "user-edit" as const, editMap: ["videoUrl"], value: "url" }] },
    }
    rehydrateFileDoc(doc, merged as never, 2000)
    const arr = getMetaEditsArray(doc.getMap("meta"))
    expect(arr.length).toBe(1)
  })
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/store/file-doc.rehydrate.test.ts 2>&1 | tail -20`
Expected: all existing tests + the 3 new ones PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/store/file-doc.ts src/lib/store/file-doc.rehydrate.test.ts
git commit -m "feat(file-doc): seed cell.edits and meta.edits during rehydrate"
```

---

## Task 8: Rewrite `useCells.deriveValidationStatus` to read from `cell.edits`

**Files:**
- Modify: `src/hooks/useCells.ts`

- [ ] **Step 1: Read the current implementation**

Skim `src/hooks/useCells.ts` top-to-bottom (148 lines). Note the `deriveValidationStatus` function (42-72) and the shape of `CellData`.

- [ ] **Step 2: Add `validationHistory` to the CellData interface**

In `src/hooks/useCells.ts`, update the `CellData` interface by inserting a new line after `activeValidators: string[]`:

```typescript
  activeValidators: string[]
  /** Read-only projection of cell.edits (value-editMap entries only, newest-last)
   *  used by the validation popover's history timeline. */
  validationHistory: import("@/lib/codex-editor/edits/types").EditValidationSummary[]
```

- [ ] **Step 3: Replace `deriveValidationStatus` to read cell.edits**

Replace the existing `deriveValidationStatus` function (lines 42-72) with:

```typescript
function deriveValidationStatus(
  translated: string,
  cell: Y.Map<unknown>,
  currentUsername: string,
  requiredValidations: number,
): { validationStatus: ValidationStatus; activeValidators: string[] } {
  if (!translated || !translated.trim()) {
    return { validationStatus: "empty", activeValidators: [] }
  }
  const arr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
  if (!arr) return { validationStatus: "none", activeValidators: [] }
  // Walk backwards for the latest value-edit.
  for (let i = arr.length - 1; i >= 0; i--) {
    const entry = arr.get(i)
    const editMapArr = entry.get("editMap") as Y.Array<string> | undefined
    if (editMapArr?.get(0) !== "value") continue
    const validators = entry.get("validatedBy") as Y.Map<Y.Map<unknown>> | undefined
    const active: string[] = []
    if (validators) {
      validators.forEach((v, username) => { if (!v.get("isDeleted")) active.push(username) })
    }
    const count = active.length
    if (count === 0) return { validationStatus: "none", activeValidators: [] }
    if (count >= requiredValidations) return { validationStatus: "full", activeValidators: active }
    if (active.includes(currentUsername)) return { validationStatus: "self", activeValidators: active }
    return { validationStatus: "others", activeValidators: active }
  }
  return { validationStatus: "none", activeValidators: [] }
}
```

- [ ] **Step 4: Build `validationHistory` in `computeOrdered` and pass to each cell**

Still in `src/hooks/useCells.ts`, at the top of the file add to the existing imports:

```typescript
import type { EditValidationSummary } from "@/lib/codex-editor/edits/types"
import { snapshotEntry } from "@/lib/codex-editor/edits/yjs-helpers"
```

Then in `computeOrdered` (after the `const { validationStatus, activeValidators } = deriveValidationStatus(...)` call, which we'll update in the next step), build the history projection:

Replace the existing `deriveValidationStatus` call (line 97-99) with:

```typescript
        const { validationStatus, activeValidators } = deriveValidationStatus(
          translated, cell, username, requiredValidations,
        )
        const editsArr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
        const validationHistory: EditValidationSummary[] = []
        if (editsArr) {
          for (let i = 0; i < editsArr.length; i++) {
            const snap = snapshotEntry(editsArr.get(i))
            if (snap.editMap[0] !== "value") continue
            const active = snap.validatedBy.filter(v => !v.isDeleted).map(v => v.username)
            validationHistory.push({
              authors: snap.authors,
              timestamp: snap.timestamp,
              type: snap.type,
              editMap: snap.editMap,
              value: snap.value,
              validatorsActive: active,
              validatorsAll: snap.validatedBy,
            })
          }
        }
```

And add `validationHistory,` to the `ordered.push({...})` object:

```typescript
        ordered.push({
          ...
          activeValidators,
          validationHistory,
          history,
          ...
        })
```

- [ ] **Step 5: Write the failing integration test**

Create `src/hooks/useCells.validation.test.tsx`:

```typescript
import { describe, it, expect } from "vitest"
import { render, act } from "@testing-library/react"
import * as Y from "yjs"
import { useCells } from "./useCells"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
import { toggleCellValidation } from "@/lib/codex-editor/edits/toggle-cell-validation"

function Probe({ doc, username, out }: { doc: Y.Doc; username: string; out: { current?: ReturnType<typeof useCells> } }) {
  const cells = useCells(doc, username, 1)
  out.current = cells
  return null
}

function setupCell(doc: Y.Doc, id: string) {
  const cellsMap = doc.getMap("cells")
  const order = doc.getArray<string>("order")
  const cell = new Y.Map<unknown>()
  cell.set("id", id)
  cell.set("original", "")
  cell.set("context", "")
  cell.set("group", "")
  cell.set("type", "text")
  const frag = new Y.XmlFragment()
  const p = new Y.XmlElement("p")
  p.insert(0, [new Y.XmlText("hello")])
  frag.insert(0, [p])
  cell.set("translatedXml", frag)
  cellsMap.set(id, cell)
  order.push([id])
}

describe("useCells — validation derivation from cell.edits", () => {
  it("shows 'self' after current user edits (auto-validate)", () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")
    const out: { current?: ReturnType<typeof useCells> } = {}
    render(<Probe doc={doc} username="alice" out={out} />)
    act(() => { commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human") })
    expect(out.current![0].validationStatus).toBe("self")
    expect(out.current![0].activeValidators).toEqual(["alice"])
  })

  it("becomes 'self' for bob after bob edits after alice (prior validator on prior entry)", () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")
    const out: { current?: ReturnType<typeof useCells> } = {}
    render(<Probe doc={doc} username="bob" out={out} />)
    const now = Date.now()
    act(() => { commitCellEdit(doc, "c1", "alice", ["value"], "hello", "human") })
    // Force a new session: advance system clock past SESSION_GAP_MS.
    const originalNow = Date.now
    Date.now = () => now + 10 * 60_000
    try {
      act(() => { commitCellEdit(doc, "c1", "bob", ["value"], "hello edited", "human") })
    } finally { Date.now = originalNow }
    expect(out.current![0].validationStatus).toBe("self")
    expect(out.current![0].activeValidators).toEqual(["bob"])
    expect(out.current![0].validationHistory.length).toBe(2)
  })

  it("shows 'full' when toggle adds a second validator and requiredValidations=2", () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")
    const out: { current?: ReturnType<typeof useCells> } = {}
    function ProbeTwo({ doc }: { doc: Y.Doc }) {
      const cells = useCells(doc, "alice", 2)
      out.current = cells
      return null
    }
    render(<ProbeTwo doc={doc} />)
    act(() => { commitCellEdit(doc, "c1", "alice", ["value"], "hi", "human") })
    expect(out.current![0].validationStatus).toBe("self")
    act(() => { toggleCellValidation(doc, "c1", "bob", true) })
    expect(out.current![0].validationStatus).toBe("full")
    expect(out.current![0].activeValidators.sort()).toEqual(["alice", "bob"])
  })
})
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/hooks/useCells.validation.test.tsx 2>&1 | tail -20`
Expected: all 3 tests PASS.

- [ ] **Step 7: Run full file to check we didn't break existing tests**

Run: `npm test -- src/hooks/useCells 2>&1 | tail -20`
Expected: all tests in the useCells suite PASS.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useCells.ts src/hooks/useCells.validation.test.tsx
git commit -m "feat(useCells): derive validation from cell.edits; add validationHistory field"
```

---

## Task 9: Wire `commitCellEdit` into `EditorTable`

**Files:**
- Modify: `src/components/EditorTable.tsx`
- Modify: `src/hooks/useCellHistory.ts`

- [ ] **Step 1: Replace `toggleCellValidation` in `useCellHistory` with a thin delegate**

Open `src/hooks/useCellHistory.ts`. First, add these two imports to the top import block (alongside the existing `* as Y from "yjs"` / `CellHistoryEntry` / richtext imports):

```typescript
import { toggleCellValidation as toggleCellEditsValidation } from "@/lib/codex-editor/edits/toggle-cell-validation"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
```

Next, replace the body of `toggleCellValidation` (lines 71-89) AND remove `updateSourceValidation` entirely (lines 91-132). Also replace `validateCell` (lines 53-64) since it relied on `updateSourceValidation`. Keep `appendCellHistory` and `recordHistoryEntry` completely unchanged.

Replace lines 53-132 with:

```typescript
export function validateCell(doc: Y.Doc, cellId: string, username: string): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return
  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
  const translated = frag ? getPlainText(frag) : ((cell.get("translated") as string) || "")
  if (!translated.trim()) return
  // Commits to the session log AND auto-validates the current user.
  commitCellEdit(doc, cellId, username, ["value"], translated, "human")
  // Keep the keystroke log entry for TipTap/audit.
  appendCellHistory(doc, cellId, { value: translated, source: "human", author: username, validated: true })
}

/**
 * Explicit validation toggle (not tied to a content commit). Delegates to
 * the Yjs-native cell.edits implementation; no more __source mutation.
 */
export function toggleCellValidation(
  doc: Y.Doc, cellId: string, username: string, validate: boolean,
): void {
  toggleCellEditsValidation(doc, cellId, username, validate)
}
```

Move the `import { toggleCellValidation ... } from ...` line up to the top import block (TypeScript allows mid-file imports but it's cleaner at the top). Same for `commitCellEdit`.

- [ ] **Step 2: Add `commitCellEdit` call alongside `recordHistoryEntry` in EditorTable**

Open `src/components/EditorTable.tsx`. Find the block around line 298:

```typescript
    recordHistoryEntry(doc, cell.id, {
      value: currentText,
      source: "human",
      author: username,
      validated: true,
    })
```

Replace it with:

```typescript
    recordHistoryEntry(doc, cell.id, {
      value: currentText,
      source: "human",
      author: username,
      validated: true,
    })
    // Dual write: cell.edits is the Yjs-native source of truth for validation;
    // cell.history keeps feeding the TipTap binding.
    commitCellEdit(doc, cell.id, username, ["value"], currentText, "human")
```

Also replace the debounced-rapid-edit block at lines 275-296 (the "Collapse rapid same-author edits" branch). After the existing `historyArr.push([{...}])` call inside the `doc.transact`, add a matching `commitCellEdit` call. Concretely, change:

```typescript
        doc.transact(() => {
          historyArr.delete(historyArr.length - 1, 1)
          historyArr.push([{
            value: currentText,
            source: "human",
            author: username,
            validated: true,
            timestamp: new Date().toISOString(),
          }])
        })
        return
```

to:

```typescript
        doc.transact(() => {
          historyArr.delete(historyArr.length - 1, 1)
          historyArr.push([{
            value: currentText,
            source: "human",
            author: username,
            validated: true,
            timestamp: new Date().toISOString(),
          }])
        })
        commitCellEdit(doc, cell.id, username, ["value"], currentText, "human")
        return
```

Add `commitCellEdit` to the imports at the top of `EditorTable.tsx`:

```typescript
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
```

- [ ] **Step 3: Run existing tests**

Run: `npm test -- src/hooks/useCellHistory src/components/EditorTable 2>&1 | tail -30`
Expected: all existing tests PASS. If any fail, the failure is likely due to old expectations on `__source.metadata.edits` mutations — those need updating (see Task 10).

- [ ] **Step 4: Run the full suite**

Run: `npm test -- --reporter=default 2>&1 | tail -25`
Expected: only serialize tests (Task 10 will fix those) and old rehydrate assertions on `__source` mutation may fail. Note which tests fail — we'll address them in the remaining tasks.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCellHistory.ts src/components/EditorTable.tsx
git commit -m "feat(editor): route validation through cell.edits; drop __source mutation"
```

---

## Task 10: Rewrite `serializeCell` to emit from `cell.edits`

**Files:**
- Modify: `src/lib/codex-editor/serialize/cell.ts`
- Create (replace): `src/lib/codex-editor/serialize/cell.test.ts` (if absent, create; else update)

- [ ] **Step 1: Check for existing cell.ts tests**

Run: `ls src/lib/codex-editor/serialize/`
Note whether `cell.test.ts` exists. If it does, plan to update it; if not, create it.

- [ ] **Step 2: Write the failing tests**

Create (or overwrite) `src/lib/codex-editor/serialize/cell.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as Y from "yjs"
import { serializeCell } from "./cell"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
import { toggleCellValidation } from "@/lib/codex-editor/edits/toggle-cell-validation"
import { setPlainText } from "@/lib/richtext/translated-xml"

function setupCell(): Y.Map<unknown> {
  const doc = new Y.Doc()
  const cell = new Y.Map<unknown>()
  const frag = new Y.XmlFragment()
  cell.set("translatedXml", frag)
  cell.set("__source", {
    kind: 2, languageId: "html", value: "",
    metadata: { id: "c1", type: "text", edits: [] },
  })
  doc.getMap("cells").set("c1", cell)
  return cell
}

describe("serializeCell — cell.edits → metadata.edits", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 3, 20, 10, 0, 0)) })
  afterEach(() => { vi.useRealTimers() })

  it("emits metadata.edits empty when cell.edits is empty", () => {
    const cell = setupCell()
    const out = serializeCell(cell)
    expect(out.metadata.edits).toEqual([])
  })

  it("emits single-author entry with author string unchanged", () => {
    const cell = setupCell()
    const frag = cell.get("translatedXml") as Y.XmlFragment
    setPlainText(frag, "hello")
    const yDoc = cell.doc!
    commitCellEdit(yDoc, "c1", "alice", ["value"], "hello", "human")
    const out = serializeCell(cell)
    expect(out.metadata.edits).toHaveLength(1)
    expect(out.metadata.edits![0].author).toBe("alice")
    expect(out.metadata.edits![0].validatedBy).toEqual([
      expect.objectContaining({ username: "alice", isDeleted: false }),
    ])
  })

  it("emits 'alice/bob' when a session has multiple authors", () => {
    const cell = setupCell()
    const frag = cell.get("translatedXml") as Y.XmlFragment
    setPlainText(frag, "hi")
    const yDoc = cell.doc!
    commitCellEdit(yDoc, "c1", "alice", ["value"], "hi", "human")
    vi.advanceTimersByTime(60_000)
    commitCellEdit(yDoc, "c1", "bob", ["value"], "hi edited", "human")
    const out = serializeCell(cell)
    expect(out.metadata.edits).toHaveLength(1)
    expect(out.metadata.edits![0].author).toBe("alice/bob")
  })

  it("emits soft-deleted validators with isDeleted: true", () => {
    const cell = setupCell()
    const frag = cell.get("translatedXml") as Y.XmlFragment
    setPlainText(frag, "hi")
    const yDoc = cell.doc!
    commitCellEdit(yDoc, "c1", "alice", ["value"], "hi", "human")
    vi.advanceTimersByTime(60_000)
    toggleCellValidation(yDoc, "c1", "alice", false)
    const out = serializeCell(cell)
    const vb = out.metadata.edits![0].validatedBy!
    expect(vb).toHaveLength(1)
    expect(vb[0].isDeleted).toBe(true)
  })

  it("omits validatedBy when the map is empty (LLM edit)", () => {
    const cell = setupCell()
    const yDoc = cell.doc!
    commitCellEdit(yDoc, "c1", "llm", ["value"], "draft", "llm")
    const out = serializeCell(cell)
    expect(out.metadata.edits![0].validatedBy).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/lib/codex-editor/serialize/cell.test.ts 2>&1 | tail -20`
Expected: FAIL — implementation still reads from `cell.history`.

- [ ] **Step 4: Rewrite serializeCell**

Replace the entire contents of `src/lib/codex-editor/serialize/cell.ts`:

```typescript
import * as Y from "yjs";
import type { CodexCell, EditHistory, EditTypeValue, ValidationEntry } from "@/lib/codex-editor/types";
import { getFragmentHtml } from "@/lib/richtext/translated-xml";
import { snapshotEntry } from "@/lib/codex-editor/edits/yjs-helpers";

/**
 * Serialize a single cell Y.Map back into the CodexCell JSON shape for a
 * .codex notebook. Starts from __source to carry unknown fields (attachments,
 * isLocked, data, etc.) verbatim, then replaces metadata.edits with a fresh
 * emit from the live cell.edits Y.Array.
 *
 * Multi-author sessions are concatenated as "alice/bob" for compat with the
 * desktop app's EditHistory.author: string shape. When upstream supports
 * author: string[], drop the concat at this one call site.
 */
export function serializeCell(cell: Y.Map<unknown>): CodexCell {
  const source = cell.get("__source") as CodexCell | undefined;
  if (!source) throw new Error("serializeCell: cell has no __source stash");
  const merged: CodexCell = JSON.parse(JSON.stringify(source));

  const editsArr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined;
  const newEdits: EditHistory[] = [];
  if (editsArr) {
    for (let i = 0; i < editsArr.length; i++) {
      const snap = snapshotEntry(editsArr.get(i));
      const entry: EditHistory = {
        // TODO: drop concat once EditHistory.author upstream supports string[]
        author: snap.authors.length > 1 ? snap.authors.join("/") : (snap.authors[0] ?? ""),
        timestamp: snap.timestamp,
        type: snap.type as EditTypeValue,
        editMap: snap.editMap,
        value: snap.value,
      };
      if (snap.validatedBy.length > 0) entry.validatedBy = snap.validatedBy as ValidationEntry[];
      newEdits.push(entry);
    }
  }
  merged.metadata.edits = newEdits;

  // Re-emit value from the current fragment if we have any edits locally.
  // If cell.edits is empty AND fragment is empty, keep the source value bytes
  // (matches current no-op semantics — serialize must be a fixed point).
  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined;
  if (frag && (newEdits.length > 0 || frag.length > 0)) {
    merged.value = getFragmentHtml(frag);
  }

  return merged;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/lib/codex-editor/serialize/cell.test.ts 2>&1 | tail -20`
Expected: all 5 tests PASS.

- [ ] **Step 6: Run the file-doc and serialize tests together**

Run: `npm test -- src/lib/codex-editor/serialize src/lib/store 2>&1 | tail -30`
Expected: all PASS. If existing golden-file tests assert old shape, update expected outputs inline.

- [ ] **Step 7: Commit**

```bash
git add src/lib/codex-editor/serialize/cell.ts src/lib/codex-editor/serialize/cell.test.ts
git commit -m "feat(serialize): emit metadata.edits from cell.edits; drop session-collapse path"
```

---

## Task 11: Rewrite `serializeFile` to emit `meta.edits` from Y.Array

**Files:**
- Modify: `src/lib/codex-editor/serialize/file.ts`
- Modify: `src/lib/codex-editor/serialize/file.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/codex-editor/serialize/file.test.ts`:

```typescript
import { commitMetaEdit } from "@/lib/codex-editor/edits/commit-meta-edit"

describe("serializeFile — meta.edits", () => {
  it("emits notebook-level edits from meta.edits Y.Array", () => {
    const doc = new Y.Doc()
    doc.getMap("meta").set("__source", { id: "n1", originalName: "n.codex" })
    commitMetaEdit(doc, ["videoUrl"], "https://example.com/a.mp4", "alice", "human")
    const out = serializeFile(doc)
    expect(out.metadata.edits).toHaveLength(1)
    expect(out.metadata.edits![0]).toEqual(expect.objectContaining({
      author: "alice",
      editMap: ["videoUrl"],
      value: "https://example.com/a.mp4",
    }))
    // FileEditHistory has no validatedBy:
    expect(out.metadata.edits![0].validatedBy).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/codex-editor/serialize/file.test.ts 2>&1 | tail -15`
Expected: FAIL — no `meta.edits` emission.

- [ ] **Step 3: Update serializeFile**

Replace the body of `src/lib/codex-editor/serialize/file.ts` with:

```typescript
import * as Y from "yjs";
import type { CodexNotebookFile, CodexNotebookMetadata, EditHistory, EditTypeValue } from "@/lib/codex-editor/types";
import { serializeCell } from "./cell";
import { snapshotEntry } from "@/lib/codex-editor/edits/yjs-helpers";

/**
 * Serialize a whole .codex notebook Y.Doc back into its on-disk JSON shape.
 * Cell order comes from the `order` Y.Array. Notebook metadata starts from
 * meta.__source (import-time snapshot) with videoUrl overridden by the live
 * Y.Map value if present, and metadata.edits emitted fresh from meta.edits
 * Y.Array (FileEditHistory shape — no validatedBy).
 */
export function serializeFile(doc: Y.Doc): CodexNotebookFile {
  const cellsMap = doc.getMap("cells");
  const order = doc.getArray<string>("order").toArray();
  const meta = doc.getMap("meta");

  const cells = order.map((id) => {
    const yCell = cellsMap.get(id) as Y.Map<unknown> | undefined;
    if (!yCell) throw new Error(`serializeFile: ordered cell ${id} missing from cells map`);
    return serializeCell(yCell);
  });

  const sourceMeta = meta.get("__source") as CodexNotebookMetadata | undefined;
  if (!sourceMeta) throw new Error("serializeFile: meta has no __source stash");
  const fileMetadata: CodexNotebookMetadata = JSON.parse(JSON.stringify(sourceMeta));

  const videoUrl = meta.get("videoUrl") as string | undefined;
  if (videoUrl !== undefined) (fileMetadata as Record<string, unknown>).videoUrl = videoUrl;

  const editsArr = meta.get("edits") as Y.Array<Y.Map<unknown>> | undefined;
  const metaEdits: EditHistory[] = [];
  if (editsArr) {
    for (let i = 0; i < editsArr.length; i++) {
      const snap = snapshotEntry(editsArr.get(i));
      metaEdits.push({
        author: snap.authors.length > 1 ? snap.authors.join("/") : (snap.authors[0] ?? ""),
        timestamp: snap.timestamp,
        type: snap.type as EditTypeValue,
        editMap: snap.editMap,
        value: snap.value,
      });
    }
  }
  fileMetadata.edits = metaEdits;

  return { cells, metadata: fileMetadata };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/codex-editor/serialize/file.test.ts 2>&1 | tail -15`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/serialize/file.ts src/lib/codex-editor/serialize/file.test.ts
git commit -m "feat(serialize): emit meta.edits from Y.Array (FileEditHistory shape)"
```

---

## Task 12: UI — swap "others" icon to filled circle

**Files:**
- Modify: `src/components/EditorTable.tsx`

- [ ] **Step 1: Update the icon picker**

In `src/components/EditorTable.tsx`, find the line near 380:

```typescript
  const ValidationIcon = vs === "full" ? CheckCheck : vs === "self" ? Check : vs === "others" ? CircleDot : Circle
```

Replace it with:

```typescript
  // "others" now uses a filled Circle (lucide has no dedicated filled-circle
  // icon; we render Circle with fill="currentColor"). Matches codex-editor
  // desktop AudioValidationStatusIcon's circle-filled codicon.
  const ValidationIcon = vs === "full" ? CheckCheck : vs === "self" ? Check : vs === "others" ? Circle : Circle
```

Then update the JSX at line 410 (`<ValidationIcon className="h-3 w-3" strokeWidth={2.5} />`) to conditionally apply `fill="currentColor"` when `vs === "others"`:

```typescript
        <HealthRing health={healthValue} size={22} strokeWidth={2}>
          <ValidationIcon
            className="h-3 w-3"
            strokeWidth={2.5}
            {...(vs === "others" ? { fill: "currentColor" } : {})}
          />
        </HealthRing>
```

Remove the now-unused `CircleDot` import from the first-line import block:

```typescript
import { Check, CheckCheck, Circle, Trash2, AlertTriangle, AlertCircle, Languages, RefreshCw, MessageCircle, History, Play } from "lucide-react"
```

- [ ] **Step 2: Run dev build lint to confirm no unused import warnings**

Run: `npm run lint -- src/components/EditorTable.tsx 2>&1 | tail -10`
Expected: no errors, no warnings about `CircleDot`.

- [ ] **Step 3: Run the full test suite**

Run: `npm test -- --reporter=default 2>&1 | tail -10`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/EditorTable.tsx
git commit -m "feat(ui): use filled circle for 'others' validation state (matches desktop)"
```

---

## Task 13: UI — validation popover history timeline

**Files:**
- Modify: `src/components/EditorTable.tsx`

- [ ] **Step 1: Expand popover and add the history section**

In `src/components/EditorTable.tsx`, find the validation popover block at lines 413-449 (opening `{validationPopoverOpen && vs !== "empty" && (`). Replace the whole popover `<div>` (through the closing `</div>` right before the outer `</div>` on line 450) with:

```tsx
      {validationPopoverOpen && vs !== "empty" && (
        <div
          ref={popoverRef}
          className={cn(
            "absolute right-7 top-0 z-50 w-72 origin-top-right rounded-lg border bg-popover p-2 shadow-lg",
            "animate-in fade-in-0 zoom-in-95 duration-150",
          )}
        >
          <ul className="space-y-0.5">
            <li className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Validated by
            </li>
            {cell.activeValidators.length === 0 ? (
              <li className="px-1 py-1 text-xs text-muted-foreground">No active validators</li>
            ) : (
              cell.activeValidators.map((v) => (
                <li key={v} className="flex items-center justify-between gap-2 rounded px-1 py-1 text-xs hover:bg-muted/50">
                  <span className="truncate">{v}{v === username ? " (you)" : ""}</span>
                  {v === username && editable && (
                    <button
                      type="button"
                      className="flex-shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                      title="Remove your validation"
                      onClick={() => {
                        toggleCellValidation(doc, cell.id, username, false)
                        setValidationPopoverOpen(false)
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </li>
              ))
            )}
          </ul>
          {cell.validationHistory.length > 0 && (
            <ValidationHistoryTimeline entries={cell.validationHistory} currentUsername={username} />
          )}
        </div>
      )}
```

- [ ] **Step 2: Implement the timeline subcomponent**

Add this component definition at the top of `src/components/EditorTable.tsx`, after the existing import block and before any existing exports:

```tsx
function ValidationHistoryTimeline({
  entries, currentUsername,
}: {
  entries: import("@/lib/codex-editor/edits/types").EditValidationSummary[]
  currentUsername: string
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  // Newest first; entries include the *current* state at the end, so skip it.
  const historical = entries.slice(0, -1).reverse()
  if (historical.length === 0) return null

  return (
    <>
      <div className="my-1 h-px bg-border" />
      <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">History</div>
      <ul className="space-y-0.5">
        {historical.map((entry, i) => {
          const snippet = typeof entry.value === "string"
            ? (entry.value.length > 40 ? entry.value.slice(0, 40) + "…" : entry.value)
            : ""
          const date = new Date(entry.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })
          const authors = entry.authors.join(", ")
          const expanded = expandedIdx === i
          return (
            <li key={`${entry.timestamp}-${i}`} className="rounded text-xs">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-1 py-1 text-left hover:bg-muted/50"
                onClick={() => setExpandedIdx(expanded ? null : i)}
              >
                <span className="truncate">
                  <span className="text-muted-foreground">{date} · </span>
                  <span>{authors}</span>
                </span>
              </button>
              {snippet && (
                <div className="px-1 pb-1 text-[11px] italic text-muted-foreground/80 truncate">"{snippet}"</div>
              )}
              {expanded && (
                <ul className="border-l border-border/50 pl-2 ml-1 mb-1 space-y-0.5">
                  {entry.validatorsAll.length === 0 ? (
                    <li className="px-1 py-0.5 text-[11px] text-muted-foreground/60">No validators on this state</li>
                  ) : entry.validatorsAll.map(v => (
                    <li
                      key={v.username}
                      className={cn(
                        "px-1 py-0.5 text-[11px] flex items-center gap-1",
                        v.isDeleted && "text-muted-foreground/50 line-through",
                      )}
                    >
                      <span>{v.username}{v.username === currentUsername ? " (you)" : ""}</span>
                      <span className="text-muted-foreground/60 ml-auto">
                        {new Date(v.updatedTimestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
```

Note: the subcomponent uses `useState` — add to the existing React import at the top if not present. `useState` is already imported per line 1 of EditorTable.

- [ ] **Step 3: Run lint and tests**

Run: `npm run lint -- src/components/EditorTable.tsx 2>&1 | tail -10`
Expected: no errors.

Run: `npm test -- src/components 2>&1 | tail -15`
Expected: all tests PASS.

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev`
- Open a .codex file in the UI.
- Edit a cell → validation icon turns self-validated (check).
- Hover the icon → popover shows "Validated by: you".
- Refresh or edit again → popover should open and show a History section with prior edits.
- Click a history row → expands to show validators on that prior state.

Expected: popover expands to w-72; timeline appears and interacts correctly.

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorTable.tsx
git commit -m "feat(ui): add validation history timeline to popover"
```

---

## Task 14: Clean up `edit-sessions.ts` usages

**Files:**
- Potentially delete: `src/lib/codex-editor/serialize/edit-sessions.ts`
- Potentially delete: `src/lib/codex-editor/serialize/edit-sessions.test.ts`

- [ ] **Step 1: Check for remaining consumers**

Run: `npm run lint 2>&1 | tail -5`
Then search:

Run: `grep -rn "collapseToEditSessions\|sessionToEditEntry" src/ 2>&1 | head -20`
Expected: only matches inside `edit-sessions.ts` itself and its test file.

- [ ] **Step 2: Delete the module (if no remaining consumers)**

If Step 1 confirmed no imports from other files:

```bash
git rm src/lib/codex-editor/serialize/edit-sessions.ts
git rm src/lib/codex-editor/serialize/edit-sessions.test.ts
```

If there ARE other consumers found in Step 1 that this plan didn't account for, STOP and surface them — they're a spec gap.

- [ ] **Step 3: Run full test suite**

Run: `npm test -- --reporter=default 2>&1 | tail -15`
Expected: all tests PASS with the module removed.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(serialize): remove unused collapseToEditSessions after cell.edits migration"
```

---

## Task 15: End-to-end verification

**Files:** N/A.

- [ ] **Step 1: Full test suite**

Run: `npm test -- --reporter=default 2>&1 | tail -20`
Expected: all tests PASS. Count should match or exceed baseline from Task 0 Step 4.

- [ ] **Step 2: Full lint**

Run: `npm run lint 2>&1 | tail -15`
Expected: no errors. Warnings about unused imports can be addressed inline.

- [ ] **Step 3: Full build**

Run: `npm run build 2>&1 | tail -20`
Expected: build succeeds. If `tsc -b` complains about unused imports or any other surfaces exposed by the changes, fix inline.

- [ ] **Step 4: Round-trip verification**

Run: `npm test -- src/lib/codex-editor/serialize 2>&1 | tail -10`
Expected: all serialize tests PASS. The task-10 and task-11 tests already cover web→disk output. If fixture-based golden files exist under `tests/fixtures/codex-editor/` and their expected output changed (e.g., `metadata.edits` ordering), update them inline and commit separately.

- [ ] **Step 5: Commit any cleanup**

If any small edits were needed to pass build/lint:

```bash
git add -A
git commit -m "chore: post-migration cleanup"
```

- [ ] **Step 6: Push branch**

```bash
git push -u origin feat/validation-history
```

Expected: branch pushed; ready for PR.
