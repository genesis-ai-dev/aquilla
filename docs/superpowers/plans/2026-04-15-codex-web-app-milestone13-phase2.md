# M13 Phase 2 — Git Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local edits to git-imported codex-editor projects round-trip back to the cloned OPFS repo and push to GitLab, byte-identical for untouched cells.

**Architecture:** Three subsystems — (1) lossless serializer that mutates cells starting from `__source` stash and folds in unsynced edit-sessions; (2) sync engine that diffs OPFS, commits, and pushes via isomorphic-git; (3) UI: toolbar Sync button + per-project auto-sync setting. Vendored codex-editor merge resolvers live alongside for Phase 3 reuse.

**Tech Stack:** isomorphic-git, Yjs, OPFS, TanStack Query, TipTap, Vitest. Reference spec: `docs/superpowers/specs/2026-04-15-codex-web-app-milestone13-phase2-git-push-design.md`. Phase 1 plan: `docs/superpowers/plans/2026-04-15-codex-web-app-milestone13-phase1.md`.

---

## File Structure

**New files:**
```
src/lib/codex-editor/merge/             # vendored pure functions from codex-editor
  validators.ts                          # mergeValidatedByLists, mergeValidatedByArrays, isValidValidationEntry
  cells.ts                               # mergeTwoCellsUsingResolverLogic, applyEditToCell
  attachments.ts                         # mergeAttachments, resolveAudioSelection
  metadata.ts                            # mergeProjectSwap, mergeSwappedUsers, mergeOriginalFilesHashes
  comments.ts                            # areCommentsDuplicate, generateCommentId, migrateComment
  migration.ts                           # migrateEditHistoryInContent, needsEditHistoryMigration
  index.ts                               # re-exports
  __test__/
    validators.test.ts
    cells.test.ts
    comments.test.ts

src/lib/codex-editor/serialize/
  edit-sessions.ts                       # collapse local sessions into EditHistory entries
  cell.ts                                # one cell Y.Map -> CodexCell JSON
  file.ts                                # whole notebook Y.Doc -> CodexNotebookFile
  comments.ts                            # comments Y state -> CodexCommentsFile
  metadata.ts                            # file/project metadata Y -> JSON
  index.ts

src/lib/sync/
  dirty.ts                               # isProjectDirty + per-file/per-cell dirty checks
  git-sync.ts                            # syncProject orchestration
  commit-message.ts                      # build commit summary

src/components/
  SyncButton.tsx                         # toolbar pill

src/hooks/
  useAutoSync.ts                         # interval-driven auto sync
  useSyncProject.ts                      # state hook around syncProject()

tests/fixtures/codex-editor/
  full-roundtrip.codex                   # cells with attachments, milestones, unknown metadata
  full-roundtrip.source
  full-roundtrip-metadata.json
  full-roundtrip-comments.json
```

**Modified files:**
```
src/lib/parsers/types.ts                 # add ProjectSyncSettings on ProjectRecord
src/lib/codex-editor/index.ts            # export merge + serialize barrels
src/lib/importer/git-importer.ts         # stash __source on every cell/thread/file metadata
src/lib/git/permissions.ts               # ≥30 access => canEditContent + canPush both true
src/components/Toolbar.tsx               # mount <SyncButton/>
src/components/ProjectSettings.tsx       # add Git Sync section
src/components/ProjectWorkspace.tsx      # mount useAutoSync
src/hooks/useProjectPermissions.ts       # no behavior change, but consumers will now see canPush
```

---

## Task 1: Vendor codex-editor merge — validators

**Files:**
- Create: `src/lib/codex-editor/merge/validators.ts`
- Create: `src/lib/codex-editor/merge/__test__/validators.test.ts`

Source: `/Users/ryderwishart/frontierrnd/codex-editor/src/projectManager/utils/merge/resolvers.ts:55-121,714-781`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { mergeValidatedByLists, isValidValidationEntry } from "../validators"

describe("isValidValidationEntry", () => {
  it("accepts a well-formed entry", () => {
    expect(isValidValidationEntry({
      username: "alice",
      creationTimestamp: 1, updatedTimestamp: 2, isDeleted: false,
    })).toBe(true)
  })
  it("rejects junk", () => {
    expect(isValidValidationEntry(null)).toBe(false)
    expect(isValidValidationEntry({ username: "x" })).toBe(false)
  })
})

describe("mergeValidatedByLists", () => {
  it("dedupes by username, keeps latest updatedTimestamp, preserves earliest creation", () => {
    const a = [{ username: "alice", creationTimestamp: 100, updatedTimestamp: 200, isDeleted: false }]
    const b = [{ username: "alice", creationTimestamp: 150, updatedTimestamp: 300, isDeleted: false }]
    const merged = mergeValidatedByLists(a, b)
    expect(merged).toHaveLength(1)
    expect(merged[0].creationTimestamp).toBe(100)
    expect(merged[0].updatedTimestamp).toBe(300)
  })

  it("unions distinct usernames, sorts alphabetically", () => {
    const a = [{ username: "bob", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: false }]
    const b = [{ username: "alice", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: false }]
    const merged = mergeValidatedByLists(a, b)
    expect(merged.map(e => e.username)).toEqual(["alice", "bob"])
  })

  it("upgrades string usernames to entries", () => {
    const merged = mergeValidatedByLists(["alice"] as unknown as ValidationEntry[], [])
    expect(merged[0].username).toBe("alice")
    expect(typeof merged[0].creationTimestamp).toBe("number")
  })

  it("handles undefined inputs", () => {
    expect(mergeValidatedByLists(undefined, undefined)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- merge/validators`
Expected: FAIL (module not found).

- [ ] **Step 3: Port the implementation verbatim**

Copy `isValidValidationEntry` (resolvers.ts:55-64), `mergeValidatedByLists` (resolvers.ts:71-121), and `mergeValidatedByArrays` (resolvers.ts:714-781) into `src/lib/codex-editor/merge/validators.ts`. Adjust imports to use our local types.

```ts
// src/lib/codex-editor/merge/validators.ts
// Vendored from codex-editor/src/projectManager/utils/merge/resolvers.ts:55-121,714-781
// Pure JS, no Node or VS Code deps.
import type { ValidationEntry, EditHistory } from "@/lib/codex-editor/types"

export function isValidValidationEntry(value: unknown): value is ValidationEntry {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return typeof v.username === "string"
    && typeof v.creationTimestamp === "number"
    && typeof v.updatedTimestamp === "number"
    && typeof v.isDeleted === "boolean"
}

export function mergeValidatedByLists(
  existing?: Array<ValidationEntry | string>,
  incoming?: Array<ValidationEntry | string>
): ValidationEntry[] {
  const upgrade = (e: ValidationEntry | string): ValidationEntry =>
    typeof e === "string"
      ? { username: e, creationTimestamp: 0, updatedTimestamp: 0, isDeleted: false }
      : e
  const all: ValidationEntry[] = [...(existing ?? []), ...(incoming ?? [])].map(upgrade)
  const byUser = new Map<string, ValidationEntry>()
  for (const e of all) {
    const prev = byUser.get(e.username)
    if (!prev) { byUser.set(e.username, e); continue }
    byUser.set(e.username, {
      username: e.username,
      creationTimestamp: Math.min(prev.creationTimestamp, e.creationTimestamp),
      updatedTimestamp: Math.max(prev.updatedTimestamp, e.updatedTimestamp),
      isDeleted: e.updatedTimestamp >= prev.updatedTimestamp ? e.isDeleted : prev.isDeleted,
    })
  }
  return [...byUser.values()].sort((a, b) => a.username.localeCompare(b.username))
}

export function mergeValidatedByArrays(
  existing: EditHistory, incoming: EditHistory
): EditHistory {
  return {
    ...existing,
    validatedBy: mergeValidatedByLists(existing.validatedBy, incoming.validatedBy),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- merge/validators`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/merge/validators.ts src/lib/codex-editor/merge/__test__/validators.test.ts
git commit -m "feat(m13.2): vendor codex-editor merge/validators (validatedBy dedup)"
```

---

## Task 2: Vendor merge — cells

**Files:**
- Create: `src/lib/codex-editor/merge/cells.ts`
- Create: `src/lib/codex-editor/merge/__test__/cells.test.ts`

Source: `resolvers.ts:1002-1071,905-962`.

- [ ] **Step 1: Read the source**

Run:
```
sed -n '900,975p;1000,1075p' /Users/ryderwishart/frontierrnd/codex-editor/src/projectManager/utils/merge/resolvers.ts
```

This dumps the two functions. Read carefully — `applyEditToCell` walks an `editMap` path and writes a leaf value; `mergeTwoCellsUsingResolverLogic` unions edit histories with a `{timestamp:editMap:value}` dedup key, then merges `validatedBy` arrays.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { mergeTwoCellsUsingResolverLogic, applyEditToCell } from "../cells"
import type { CodexCell, EditHistory } from "@/lib/codex-editor/types"

function cell(extra: Partial<CodexCell> = {}): CodexCell {
  return {
    kind: 2, languageId: "scripture", value: "v",
    metadata: { id: "c1", type: "text", edits: [] },
    ...extra,
  }
}

describe("mergeTwoCellsUsingResolverLogic", () => {
  it("dedupes edits by {timestamp,editMap,value}", () => {
    const e: EditHistory = { author: "a", timestamp: 1, type: "user-edit", editMap: ["value"], value: "x" }
    const merged = mergeTwoCellsUsingResolverLogic(
      cell({ metadata: { id: "c1", type: "text", edits: [e] } }),
      cell({ metadata: { id: "c1", type: "text", edits: [e] } }),
    )
    expect(merged.metadata.edits).toHaveLength(1)
  })

  it("unions edits, sorted by timestamp", () => {
    const e1: EditHistory = { author: "a", timestamp: 100, type: "user-edit", editMap: ["value"], value: "x" }
    const e2: EditHistory = { author: "b", timestamp: 50, type: "user-edit", editMap: ["value"], value: "y" }
    const merged = mergeTwoCellsUsingResolverLogic(
      cell({ metadata: { id: "c1", type: "text", edits: [e1] } }),
      cell({ metadata: { id: "c1", type: "text", edits: [e2] } }),
    )
    expect(merged.metadata.edits!.map(e => e.timestamp)).toEqual([50, 100])
  })

  it("merges validatedBy across duplicate edits", () => {
    const base: EditHistory = {
      author: "a", timestamp: 1, type: "user-edit", editMap: ["value"], value: "x",
      validatedBy: [{ username: "alice", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: false }],
    }
    const other: EditHistory = {
      ...base,
      validatedBy: [{ username: "bob", creationTimestamp: 2, updatedTimestamp: 2, isDeleted: false }],
    }
    const merged = mergeTwoCellsUsingResolverLogic(
      cell({ metadata: { id: "c1", type: "text", edits: [base] } }),
      cell({ metadata: { id: "c1", type: "text", edits: [other] } }),
    )
    expect(merged.metadata.edits![0].validatedBy?.map(v => v.username).sort()).toEqual(["alice", "bob"])
  })
})

describe("applyEditToCell", () => {
  it("writes the leaf at editMap path", () => {
    const c = cell()
    applyEditToCell(c, {
      author: "a", timestamp: 1, type: "user-edit", editMap: ["value"], value: "new",
    })
    expect(c.value).toBe("new")
  })
  it("writes nested metadata path", () => {
    const c = cell()
    applyEditToCell(c, {
      author: "a", timestamp: 1, type: "user-edit",
      editMap: ["metadata", "data", "startTime"], value: 1.5,
    })
    expect(c.metadata.data?.startTime).toBe(1.5)
  })
})
```

- [ ] **Step 3: Run to fail**

Run: `npm test -- merge/cells`
Expected: FAIL.

- [ ] **Step 4: Implement**

Port the two functions. Skeleton (fill in from source):

```ts
// src/lib/codex-editor/merge/cells.ts
// Vendored from codex-editor/src/projectManager/utils/merge/resolvers.ts:905-962,1002-1071
import type { CodexCell, EditHistory } from "@/lib/codex-editor/types"
import { mergeValidatedByLists } from "./validators"

export function applyEditToCell(cell: CodexCell, edit: EditHistory): void {
  let target: Record<string, unknown> = cell as unknown as Record<string, unknown>
  const path = edit.editMap.slice(0, -1)
  const leaf = edit.editMap[edit.editMap.length - 1]
  for (const segment of path) {
    if (target[segment] == null || typeof target[segment] !== "object") {
      target[segment] = {}
    }
    target = target[segment] as Record<string, unknown>
  }
  target[leaf] = edit.value
}

export function mergeTwoCellsUsingResolverLogic(a: CodexCell, b: CodexCell): CodexCell {
  // Start from the cell whose latest edit timestamp wins on simple fields.
  const merged: CodexCell = JSON.parse(JSON.stringify(a))
  const editsA = a.metadata.edits ?? []
  const editsB = b.metadata.edits ?? []
  const byKey = new Map<string, EditHistory>()
  const keyOf = (e: EditHistory) => `${e.timestamp}:${e.editMap.join(".")}:${JSON.stringify(e.value)}`
  for (const e of [...editsA, ...editsB]) {
    const k = keyOf(e)
    const prev = byKey.get(k)
    if (!prev) { byKey.set(k, e); continue }
    byKey.set(k, { ...prev, validatedBy: mergeValidatedByLists(prev.validatedBy, e.validatedBy) })
  }
  merged.metadata.edits = [...byKey.values()].sort((x, y) => x.timestamp - y.timestamp)

  // Apply the latest edit per editMap path so cell value reflects newest state.
  const byPath = new Map<string, EditHistory>()
  for (const e of merged.metadata.edits) {
    const k = e.editMap.join(".")
    const prev = byPath.get(k)
    if (!prev || e.timestamp > prev.timestamp) byPath.set(k, e)
  }
  for (const e of byPath.values()) applyEditToCell(merged, e)
  return merged
}
```

- [ ] **Step 5: Run to pass**

Run: `npm test -- merge/cells`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/codex-editor/merge/cells.ts src/lib/codex-editor/merge/__test__/cells.test.ts
git commit -m "feat(m13.2): vendor codex-editor merge/cells (per-path latest-wins)"
```

---

## Task 3: Vendor merge — comments + barrel

**Files:**
- Create: `src/lib/codex-editor/merge/comments.ts`
- Create: `src/lib/codex-editor/merge/__test__/comments.test.ts`
- Create: `src/lib/codex-editor/merge/index.ts`

Source: `resolvers.ts:389,397,413,497`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { areCommentsDuplicate, generateCommentId } from "../comments"

describe("generateCommentId", () => {
  it("returns a non-empty unique-ish string", () => {
    const a = generateCommentId()
    const b = generateCommentId()
    expect(a).toMatch(/.+/)
    expect(a).not.toBe(b)
  })
})

describe("areCommentsDuplicate", () => {
  it("matches by id", () => {
    expect(areCommentsDuplicate(
      { id: "1", body: "hi", author: { name: "a" }, timestamp: 1, mode: 0, deleted: false },
      { id: "1", body: "different", author: { name: "b" }, timestamp: 2, mode: 0, deleted: false },
    )).toBe(true)
  })
  it("matches by body+author when ids differ (legacy)", () => {
    expect(areCommentsDuplicate(
      { id: "1", body: "hi", author: { name: "a" }, timestamp: 1, mode: 0, deleted: false },
      { id: "2", body: "hi", author: { name: "a" }, timestamp: 9, mode: 0, deleted: false },
    )).toBe(true)
  })
  it("rejects different content", () => {
    expect(areCommentsDuplicate(
      { id: "1", body: "x", author: { name: "a" }, timestamp: 1, mode: 0, deleted: false },
      { id: "2", body: "y", author: { name: "a" }, timestamp: 1, mode: 0, deleted: false },
    )).toBe(false)
  })
})
```

- [ ] **Step 2: Run to fail**

Run: `npm test -- merge/comments`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/codex-editor/merge/comments.ts
// Vendored from codex-editor/src/projectManager/utils/merge/resolvers.ts:389,397,413,497
import type { CodexComment } from "@/lib/codex-editor/types"

export function generateCommentId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function areCommentsDuplicate(a: CodexComment, b: CodexComment): boolean {
  if (a.id && b.id && a.id === b.id) return true
  return a.body === b.body && a.author?.name === b.author?.name
}

export function migrateComment(c: Partial<CodexComment> & { id?: string }): CodexComment {
  return {
    id: c.id || generateCommentId(),
    timestamp: c.timestamp ?? Date.now(),
    body: c.body ?? "",
    mode: c.mode ?? 0,
    deleted: c.deleted ?? false,
    author: c.author ?? { name: "unknown" },
  }
}
```

- [ ] **Step 4: Run to pass**

Run: `npm test -- merge/comments`
Expected: PASS.

- [ ] **Step 5: Write the barrel**

`src/lib/codex-editor/merge/index.ts`:

```ts
export * from "./validators"
export * from "./cells"
export * from "./comments"
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/codex-editor/merge/
git commit -m "feat(m13.2): vendor codex-editor merge/comments + barrel"
```

---

## Task 4: Stash __source on import

**Files:**
- Modify: `src/lib/importer/git-importer.ts`
- Modify: `src/lib/importer/git-importer.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `git-importer.test.ts`:

```ts
it("stashes __source on every cell, on file metadata, and on threads", async () => {
  const root = new MemoryDirectoryHandle("r")
  const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle)
  await fs.promises.mkdir("/repo/files/target", { recursive: true })
  await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true })
  await fs.promises.writeFile("/repo/metadata.json", readFix("metadata.json"))
  await fs.promises.writeFile("/repo/files/target/sample.codex", readFix("sample.codex"))
  await fs.promises.writeFile("/repo/.project/sourceTexts/sample.source", readFix("sample.source"))
  await fs.promises.writeFile("/repo/.project/comments.json", readFix("comments.json"))

  const { project, docs } = await importFromOpfs({
    fs, repoDir: "/repo",
    origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
    permissions: { source: "gitlab", canEditContent: true, canEditComments: true, canResolveComments: true, canPush: true, accessLevel: 30 },
  })

  const doc = docs[project.files[0].id]
  const cellsMap = doc.getMap("cells")
  const cell1 = cellsMap.get("GEN 1:1") as Y.Map<unknown>
  const cellSource = cell1.get("__source") as Record<string, unknown>
  expect(cellSource).toBeDefined()
  expect(cellSource.metadata).toBeDefined()

  const meta = doc.getMap("meta")
  expect(meta.get("__source")).toBeDefined()

  const threadsArr = cell1.get("threads") as Y.Array<Y.Map<unknown>>
  expect(threadsArr.get(0).get("__source")).toBeDefined()
})
```

- [ ] **Step 2: Run to fail**

Run: `npm test -- git-importer`
Expected: FAIL on the new test.

- [ ] **Step 3: Modify importer to stash __source**

In `git-importer.ts`, inside the `doc.transact()` block where we layer in cells, immediately after `setFragmentFromHtml(...)` for each cell, also:

```ts
for (const sourceCell of nb.cells) {
  const cell = cellsMap.get(sourceCell.metadata.id) as Y.Map<unknown> | undefined
  if (!cell) continue
  cell.set("__source", JSON.parse(JSON.stringify(sourceCell)))
}
```

For file metadata, after `metaMap.set("videoUrl", ...)`:

```ts
metaMap.set("__source", JSON.parse(JSON.stringify(nb.metadata)))
```

For threads, inside the threads loop after `tm.set("messages", ...)`, find the matching original thread JSON and stash:

```ts
const originalThreadJson = findOriginalThread(commentsFile, t.id)
if (originalThreadJson) tm.set("__source", JSON.parse(JSON.stringify(originalThreadJson)))
```

You'll need to thread the original `commentsFile` (raw `CodexCommentsFile` from `parseCodexComments`) into the loop. Adjust `mapCodexCommentsToThreads` or duplicate the parse so we have both.

Cleaner: change the importer to keep `parsedComments: CodexCommentsFile` around and stash from there.

- [ ] **Step 4: Run to pass**

Run: `npm test -- git-importer`
Expected: PASS (3 importer tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/importer/git-importer.ts src/lib/importer/git-importer.test.ts
git commit -m "feat(m13.2): stash __source on cells, file metadata, and comment threads at import"
```

---

## Task 5: Stash originalFileListing on the project

**Files:**
- Modify: `src/lib/importer/git-importer.ts`
- Modify: `src/lib/parsers/types.ts`
- Modify: `src/lib/importer/git-importer.test.ts`

We need a record of every file the cloned repo contains so the serializer can leave non-managed files (`.vscode/`, `fonts/`, etc.) alone.

- [ ] **Step 1: Add field to ProjectRecord**

In `src/lib/parsers/types.ts`, on `ProjectRecord` add:

```ts
  /**
   * Map: relative path -> SHA-256 of file content as cloned. Used by the
   * serializer to skip non-managed files. Populated only for git-imported
   * projects.
   */
  originalFileListing?: Record<string, string>;
```

- [ ] **Step 2: Write failing test**

Append to importer test:

```ts
it("records every file path in originalFileListing", async () => {
  // ...same setup as previous test...
  const { project } = await importFromOpfs({ /* ... */ })
  expect(project.originalFileListing).toBeDefined()
  expect(Object.keys(project.originalFileListing!)).toEqual(
    expect.arrayContaining([
      "/metadata.json",
      "/files/target/sample.codex",
      "/.project/sourceTexts/sample.source",
      "/.project/comments.json",
    ])
  )
})
```

- [ ] **Step 3: Run to fail**

Run: `npm test -- git-importer`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `git-importer.ts`, after the cell-import loop and before building `ProjectRecord`, walk the entire repo and hash each file:

```ts
async function buildFileListing(fs: OpfsFs, root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(dir: string) {
    const names = await fs.promises.readdir(dir).catch(() => [])
    for (const name of names) {
      if (name === ".git") continue
      const full = dir === "/" ? `/${name}` : `${dir}/${name}`
      const stat = await fs.promises.stat(full).catch(() => null)
      if (!stat) continue
      if (stat.isDirectory()) await walk(full)
      else if (stat.isFile()) {
        const bytes = await fs.promises.readFile(full) as Uint8Array
        out[full] = await sha256Hex(bytes)
      }
    }
  }
  await walk(root === "/" ? "/" : root)
  return out
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}
```

Then on the `ProjectRecord` set `originalFileListing: await buildFileListing(fs, "/")`.

Skip `.git` to keep the listing reasonable.

- [ ] **Step 5: Run to pass**

Run: `npm test -- git-importer`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/parsers/types.ts src/lib/importer/git-importer.ts src/lib/importer/git-importer.test.ts
git commit -m "feat(m13.2): record originalFileListing (path -> sha256) on git-imported projects"
```

---

## Task 6: Edit-session collapse helper

**Files:**
- Create: `src/lib/codex-editor/serialize/edit-sessions.ts`
- Create: `src/lib/codex-editor/serialize/edit-sessions.test.ts`

Reuse the existing `isSameEditSession` heuristic from `HistoryDrawer`.

- [ ] **Step 1: Locate the existing heuristic**

Run: `grep -n "isSameEditSession\|sessionGap" src/components/HistoryDrawer.tsx | head`

Read the surrounding context. The heuristic is something like "same author + < N seconds apart". Hoist it into a shared module if it isn't already.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { collapseToEditSessions, sessionToEditEntry } from "./edit-sessions"
import type { CellHistoryEntry } from "@/lib/parsers/types"

const e = (overrides: Partial<CellHistoryEntry>): CellHistoryEntry => ({
  timestamp: "2026-01-01T00:00:00.000Z",
  value: "v",
  source: "human",
  author: "alice",
  validated: false,
  ...overrides,
})

describe("collapseToEditSessions", () => {
  it("groups contiguous same-author entries within session window", () => {
    const entries = [
      e({ timestamp: "2026-01-01T00:00:00Z", value: "a" }),
      e({ timestamp: "2026-01-01T00:00:30Z", value: "ab" }),
      e({ timestamp: "2026-01-01T00:01:00Z", value: "abc" }),
    ]
    const sessions = collapseToEditSessions(entries)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].finalValue).toBe("abc")
  })

  it("starts a new session when author changes", () => {
    const entries = [
      e({ author: "alice", value: "a" }),
      e({ author: "bob", value: "b", timestamp: "2026-01-01T00:00:01Z" }),
    ]
    expect(collapseToEditSessions(entries)).toHaveLength(2)
  })

  it("starts a new session when gap exceeds window", () => {
    const entries = [
      e({ value: "a", timestamp: "2026-01-01T00:00:00Z" }),
      e({ value: "b", timestamp: "2026-01-01T00:10:00Z" }), // 10 min gap
    ]
    expect(collapseToEditSessions(entries)).toHaveLength(2)
  })
})

describe("sessionToEditEntry", () => {
  it("emits a value-edit", () => {
    const session = {
      author: "alice", source: "human" as const, validated: true,
      startTimestamp: 1, endTimestamp: 2, finalValue: "<p>x</p>",
      entries: [],
    }
    const edit = sessionToEditEntry(session)
    expect(edit.editMap).toEqual(["value"])
    expect(edit.value).toBe("<p>x</p>")
    expect(edit.author).toBe("alice")
    expect(edit.type).toBe("user-edit")
  })
  it("maps llm source to llm-edit", () => {
    const session = {
      author: "bot", source: "llm" as const, validated: false,
      startTimestamp: 1, endTimestamp: 1, finalValue: "x", entries: [],
    }
    expect(sessionToEditEntry(session).type).toBe("llm-edit")
  })
})
```

- [ ] **Step 3: Run to fail**

Run: `npm test -- edit-sessions`
Expected: FAIL.

- [ ] **Step 4: Implement**

```ts
// src/lib/codex-editor/serialize/edit-sessions.ts
import type { CellHistoryEntry } from "@/lib/parsers/types"
import type { EditHistory, EditTypeValue } from "@/lib/codex-editor/types"

const SESSION_GAP_MS = 5 * 60_000 // 5 min

export interface EditSession {
  author: string
  source: "human" | "llm"
  validated: boolean
  startTimestamp: number
  endTimestamp: number
  finalValue: string
  entries: CellHistoryEntry[]
}

export function collapseToEditSessions(entries: CellHistoryEntry[]): EditSession[] {
  const sessions: EditSession[] = []
  for (const e of entries) {
    const ts = Date.parse(e.timestamp)
    const last = sessions[sessions.length - 1]
    if (
      last
      && last.author === e.author
      && last.source === e.source
      && (ts - last.endTimestamp) <= SESSION_GAP_MS
    ) {
      last.endTimestamp = ts
      last.finalValue = e.value
      last.validated = e.validated
      last.entries.push(e)
    } else {
      sessions.push({
        author: e.author,
        source: e.source,
        validated: e.validated,
        startTimestamp: ts,
        endTimestamp: ts,
        finalValue: e.value,
        entries: [e],
      })
    }
  }
  return sessions
}

export function sessionToEditEntry(s: EditSession): EditHistory {
  const type: EditTypeValue =
    s.source === "llm" ? "llm-edit" : "user-edit"
  return {
    author: s.author,
    timestamp: s.endTimestamp,
    type,
    editMap: ["value"],
    value: s.finalValue,
  }
}
```

- [ ] **Step 5: Run to pass**

Run: `npm test -- edit-sessions`
Expected: PASS.

- [ ] **Step 6: Update HistoryDrawer to import the shared heuristic**

If `HistoryDrawer.tsx` has its own copy of session grouping logic, replace it with `import { collapseToEditSessions } from "@/lib/codex-editor/serialize/edit-sessions"` so future changes stay in sync.

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/codex-editor/serialize/edit-sessions.ts src/lib/codex-editor/serialize/edit-sessions.test.ts src/components/HistoryDrawer.tsx
git commit -m "feat(m13.2): edit-session collapser shared between HistoryDrawer and serializer"
```

---

## Task 7: Cell serializer

**Files:**
- Create: `src/lib/codex-editor/serialize/cell.ts`
- Create: `src/lib/codex-editor/serialize/cell.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { serializeCell } from "./cell"
import type { CodexCell } from "@/lib/codex-editor/types"
import { setFragmentFromHtml } from "@/lib/richtext/translated-xml"

function buildYCell(source: CodexCell, lastSyncedHistoryAt = 0): Y.Map<unknown> {
  const doc = new Y.Doc()
  const m = doc.getMap("c")
  const cell = new Y.Map<unknown>()
  cell.set("id", source.metadata.id)
  cell.set("__source", JSON.parse(JSON.stringify(source)))
  cell.set("__lastSyncedHistoryAt", lastSyncedHistoryAt)
  const frag = new Y.XmlFragment()
  cell.set("translatedXml", frag)
  setFragmentFromHtml(frag, source.value)
  cell.set("history", new Y.Array())
  cell.set("threads", new Y.Array())
  m.set("c", cell)
  return cell
}

describe("serializeCell", () => {
  it("byte-identical output when nothing changed", () => {
    const source: CodexCell = {
      kind: 2, languageId: "scripture",
      value: "<p>Im Anfang</p>",
      metadata: {
        id: "GEN 1:1", type: "text",
        edits: [{ author: "a", timestamp: 1, type: "user-edit", editMap: ["value"], value: "<p>Im Anfang</p>" }],
        data: { book: "GEN", chapter: "1", verse: "1" },
        attachments: { aud1: { type: "audio", url: "x" } as any },
      },
    }
    const cell = buildYCell(source, 999)
    const out = serializeCell(cell)
    expect(out).toEqual(source)
  })

  it("appends a new edit when text changed", () => {
    const source: CodexCell = {
      kind: 2, languageId: "scripture",
      value: "<p>old</p>",
      metadata: { id: "GEN 1:1", type: "text", edits: [] },
    }
    const cell = buildYCell(source, 0)
    const frag = cell.get("translatedXml") as Y.XmlFragment
    setFragmentFromHtml(frag, "<p>new</p>")
    // Simulate a recorded local edit session via the history Y.Array
    const hist = cell.get("history") as Y.Array<unknown>
    hist.push([{ timestamp: new Date(50_000).toISOString(), value: "<p>new</p>", source: "human", author: "alice", validated: false }])

    const out = serializeCell(cell)
    expect(out.value).toBe("<p>new</p>")
    expect(out.metadata.edits).toHaveLength(1)
    expect(out.metadata.edits![0]).toMatchObject({
      author: "alice", value: "<p>new</p>", editMap: ["value"], type: "user-edit",
    })
  })

  it("preserves unknown fields (attachments, cellLabel, isLocked)", () => {
    const source: CodexCell = {
      kind: 2, languageId: "scripture", value: "<p>x</p>",
      metadata: {
        id: "X", type: "text", cellLabel: "1:1", isLocked: true,
        attachments: { a1: { foo: "bar" } as any },
      } as any,
    }
    const cell = buildYCell(source, 999)
    const out = serializeCell(cell)
    expect((out.metadata as any).cellLabel).toBe("1:1")
    expect((out.metadata as any).isLocked).toBe(true)
    expect((out.metadata as any).attachments.a1.foo).toBe("bar")
  })
})
```

- [ ] **Step 2: Run to fail**

Run: `npm test -- serialize/cell`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/codex-editor/serialize/cell.ts
import * as Y from "yjs"
import type { CodexCell, EditHistory } from "@/lib/codex-editor/types"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { getFragmentHtml } from "@/lib/richtext/translated-xml"
import { collapseToEditSessions, sessionToEditEntry } from "./edit-sessions"

export function serializeCell(cell: Y.Map<unknown>): CodexCell {
  const source = cell.get("__source") as CodexCell | undefined
  if (!source) throw new Error("serializeCell: cell has no __source stash")
  const merged: CodexCell = JSON.parse(JSON.stringify(source))

  // Current value from XmlFragment.
  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
  if (frag) merged.value = getFragmentHtml(frag)

  // Fold unsynced edit sessions in.
  const lastSynced = (cell.get("__lastSyncedHistoryAt") as number) ?? 0
  const histArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
  const localEntries = (histArr?.toArray() ?? []).filter(e => Date.parse(e.timestamp) > lastSynced)
  const newEdits: EditHistory[] = collapseToEditSessions(localEntries).map(sessionToEditEntry)
  if (newEdits.length) {
    merged.metadata.edits = [...(merged.metadata.edits ?? []), ...newEdits]
  }

  return merged
}
```

- [ ] **Step 4: Run to pass**

Run: `npm test -- serialize/cell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/serialize/cell.ts src/lib/codex-editor/serialize/cell.test.ts
git commit -m "feat(m13.2): per-cell serializer (start from __source, fold sessions, preserve unknown fields)"
```

---

## Task 8: File serializer (notebook)

**Files:**
- Create: `src/lib/codex-editor/serialize/file.ts`
- Create: `src/lib/codex-editor/serialize/file.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Y from "yjs"
import { createOpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { importFromOpfs } from "@/lib/importer/git-importer"
import { serializeFile } from "./file"

const FIX = join(__dirname, "../../../../tests/fixtures/codex-editor")

describe("serializeFile", () => {
  it("round-trips byte-identical for an unmodified import", async () => {
    const root = new MemoryDirectoryHandle("r")
    const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle)
    await fs.promises.mkdir("/repo/files/target", { recursive: true })
    await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true })
    await fs.promises.writeFile("/repo/metadata.json", readFileSync(join(FIX, "metadata.json"), "utf8"))
    await fs.promises.writeFile("/repo/files/target/sample.codex", readFileSync(join(FIX, "sample.codex"), "utf8"))
    await fs.promises.writeFile("/repo/.project/sourceTexts/sample.source", readFileSync(join(FIX, "sample.source"), "utf8"))

    const { project, docs } = await importFromOpfs({
      fs, repoDir: "/repo",
      origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
      permissions: { source: "gitlab", canEditContent: true, canEditComments: true, canResolveComments: true, canPush: true, accessLevel: 30 },
    })

    const doc = docs[project.files[0].id]
    const out = serializeFile(doc)
    const original = JSON.parse(readFileSync(join(FIX, "sample.codex"), "utf8"))
    expect(out).toEqual(original)
  })
})
```

- [ ] **Step 2: Run to fail**

Run: `npm test -- serialize/file`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/codex-editor/serialize/file.ts
import * as Y from "yjs"
import type { CodexNotebookFile, CodexNotebookMetadata } from "@/lib/codex-editor/types"
import { serializeCell } from "./cell"

export function serializeFile(doc: Y.Doc): CodexNotebookFile {
  const cellsMap = doc.getMap("cells")
  const order = doc.getArray<string>("order").toArray()
  const meta = doc.getMap("meta")

  const cells = order.map(id => {
    const yCell = cellsMap.get(id) as Y.Map<unknown> | undefined
    if (!yCell) throw new Error(`serializeFile: ordered cell ${id} missing from cells map`)
    return serializeCell(yCell)
  })

  const sourceMeta = meta.get("__source") as CodexNotebookMetadata | undefined
  if (!sourceMeta) throw new Error("serializeFile: meta has no __source stash")
  const fileMetadata: CodexNotebookMetadata = JSON.parse(JSON.stringify(sourceMeta))

  // Override video fields if present (Phase 2 doesn't expose other meta edits).
  const videoUrl = meta.get("videoUrl") as string | undefined
  if (videoUrl !== undefined) (fileMetadata as Record<string, unknown>).videoUrl = videoUrl

  return { cells, metadata: fileMetadata }
}
```

- [ ] **Step 4: Run to pass**

Run: `npm test -- serialize/file`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/serialize/file.ts src/lib/codex-editor/serialize/file.test.ts
git commit -m "feat(m13.2): notebook file serializer (cells in order + stashed metadata)"
```

---

## Task 9: Comments + metadata serializer

**Files:**
- Create: `src/lib/codex-editor/serialize/comments.ts`
- Create: `src/lib/codex-editor/serialize/comments.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createOpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { importFromOpfs } from "@/lib/importer/git-importer"
import { serializeComments } from "./comments"

const FIX = join(__dirname, "../../../../tests/fixtures/codex-editor")

describe("serializeComments", () => {
  it("round-trips comments.json byte-equal when unchanged", async () => {
    const root = new MemoryDirectoryHandle("r")
    const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle)
    await fs.promises.mkdir("/repo/files/target", { recursive: true })
    await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true })
    await fs.promises.writeFile("/repo/metadata.json", readFileSync(join(FIX, "metadata.json"), "utf8"))
    await fs.promises.writeFile("/repo/files/target/sample.codex", readFileSync(join(FIX, "sample.codex"), "utf8"))
    await fs.promises.writeFile("/repo/.project/sourceTexts/sample.source", readFileSync(join(FIX, "sample.source"), "utf8"))
    await fs.promises.writeFile("/repo/.project/comments.json", readFileSync(join(FIX, "comments.json"), "utf8"))

    const { docs } = await importFromOpfs({
      fs, repoDir: "/repo",
      origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
      permissions: { source: "gitlab", canEditContent: true, canEditComments: true, canResolveComments: true, canPush: true, accessLevel: 30 },
    })

    const out = serializeComments(Object.values(docs))
    const original = JSON.parse(readFileSync(join(FIX, "comments.json"), "utf8"))
    expect(out).toEqual(original)
  })
})
```

- [ ] **Step 2: Run to fail**

Run: `npm test -- serialize/comments`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/codex-editor/serialize/comments.ts
import * as Y from "yjs"
import type { CodexCommentsFile, CodexCommentThread } from "@/lib/codex-editor/types"

export function serializeComments(docs: Y.Doc[]): CodexCommentsFile {
  const out: CodexCommentsFile = {}
  for (const doc of docs) {
    const cellsMap = doc.getMap("cells")
    for (const cellId of cellsMap.keys()) {
      const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
      if (!cell) continue
      const threadsArr = cell.get("threads") as Y.Array<Y.Map<unknown>> | undefined
      if (!threadsArr) continue
      for (let i = 0; i < threadsArr.length; i++) {
        const t = threadsArr.get(i)
        const source = t.get("__source") as CodexCommentThread | undefined
        if (!source) continue // new threads handled in Phase 3+
        out[source.id] = JSON.parse(JSON.stringify(source))
      }
    }
  }
  return out
}
```

- [ ] **Step 4: Run to pass**

Run: `npm test -- serialize/comments`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/serialize/comments.ts src/lib/codex-editor/serialize/comments.test.ts
git commit -m "feat(m13.2): comments serializer (Phase 2: stash-only, no new threads)"
```

---

## Task 10: Serialize barrel + project metadata serializer

**Files:**
- Create: `src/lib/codex-editor/serialize/metadata.ts`
- Create: `src/lib/codex-editor/serialize/index.ts`

- [ ] **Step 1: Implement project metadata serializer**

```ts
// src/lib/codex-editor/serialize/metadata.ts
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CodexProjectMetadata } from "@/lib/codex-editor/types"

// Phase 2 doesn't surface project-level metadata edits; preserve disk verbatim.
export function serializeProjectMetadata(_project: ProjectRecord, original: CodexProjectMetadata): CodexProjectMetadata {
  return JSON.parse(JSON.stringify(original))
}
```

- [ ] **Step 2: Barrel**

```ts
// src/lib/codex-editor/serialize/index.ts
export * from "./edit-sessions"
export * from "./cell"
export * from "./file"
export * from "./comments"
export * from "./metadata"
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/codex-editor/serialize/
git commit -m "chore(m13.2): serialize barrel + project metadata passthrough"
```

---

## Task 11: Dirty detection

**Files:**
- Create: `src/lib/sync/dirty.ts`
- Create: `src/lib/sync/dirty.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import "fake-indexeddb/auto"
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createOpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { importFromOpfs } from "@/lib/importer/git-importer"
import { isFileDirty } from "./dirty"
import { setFragmentFromHtml } from "@/lib/richtext/translated-xml"
import * as Y from "yjs"

const FIX = join(__dirname, "../../../tests/fixtures/codex-editor")

async function importSample() {
  const root = new MemoryDirectoryHandle("r")
  const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle)
  await fs.promises.mkdir("/repo/files/target", { recursive: true })
  await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true })
  await fs.promises.writeFile("/repo/metadata.json", readFileSync(join(FIX, "metadata.json"), "utf8"))
  await fs.promises.writeFile("/repo/files/target/sample.codex", readFileSync(join(FIX, "sample.codex"), "utf8"))
  await fs.promises.writeFile("/repo/.project/sourceTexts/sample.source", readFileSync(join(FIX, "sample.source"), "utf8"))
  return importFromOpfs({
    fs, repoDir: "/repo",
    origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
    permissions: { source: "gitlab", canEditContent: true, canEditComments: true, canResolveComments: true, canPush: true, accessLevel: 30 },
  })
}

describe("isFileDirty", () => {
  it("returns false right after import", async () => {
    const { docs } = await importSample()
    expect(isFileDirty(Object.values(docs)[0])).toBe(false)
  })

  it("returns true after a cell value edit", async () => {
    const { docs } = await importSample()
    const doc = Object.values(docs)[0]
    const cellsMap = doc.getMap("cells")
    const c = cellsMap.get("GEN 1:1") as Y.Map<unknown>
    const frag = c.get("translatedXml") as Y.XmlFragment
    setFragmentFromHtml(frag, "<p>changed</p>")
    expect(isFileDirty(doc)).toBe(true)
  })

  it("returns true after a new history entry", async () => {
    const { docs } = await importSample()
    const doc = Object.values(docs)[0]
    const cellsMap = doc.getMap("cells")
    const c = cellsMap.get("GEN 1:1") as Y.Map<unknown>
    const hist = c.get("history") as Y.Array<unknown>
    hist.push([{ timestamp: new Date().toISOString(), value: "<p>x</p>", source: "human", author: "alice", validated: false }])
    expect(isFileDirty(doc)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to fail**

Run: `npm test -- sync/dirty`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/sync/dirty.ts
import * as Y from "yjs"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { getFragmentHtml } from "@/lib/richtext/translated-xml"

export function isCellDirty(cell: Y.Map<unknown>): boolean {
  const source = cell.get("__source") as CodexCell | undefined
  if (!source) return true // new cell — treat as dirty (Phase 2 doesn't add cells but defensive)

  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
  const currentValue = frag ? getFragmentHtml(frag) : ""
  if (currentValue !== source.value) return true

  const lastSynced = (cell.get("__lastSyncedHistoryAt") as number) ?? 0
  const histArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
  if (histArr) {
    for (const e of histArr.toArray()) {
      if (Date.parse(e.timestamp) > lastSynced) return true
    }
  }
  return false
}

export function isFileDirty(doc: Y.Doc): boolean {
  const cellsMap = doc.getMap("cells")
  for (const id of cellsMap.keys()) {
    const c = cellsMap.get(id) as Y.Map<unknown> | undefined
    if (c && isCellDirty(c)) return true
  }
  return false
}
```

- [ ] **Step 4: Run to pass**

Run: `npm test -- sync/dirty`
Expected: PASS.

- [ ] **Step 5: Add isProjectDirty (loads docs from IDB)**

Append:

```ts
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"
import type { ProjectRecord } from "@/lib/parsers/types"

export async function isProjectDirty(project: ProjectRecord): Promise<boolean> {
  for (const f of project.files) {
    const handle = loadFileDoc(f.id)
    try {
      await new Promise<void>(r => handle.persistence.synced ? r() : handle.persistence.once("synced", () => r()))
      if (isFileDirty(handle.doc)) return true
    } finally {
      destroyFileDoc(handle)
    }
  }
  return false
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -b --noEmit`
```bash
git add src/lib/sync/dirty.ts src/lib/sync/dirty.test.ts
git commit -m "feat(m13.2): per-cell, per-file, per-project dirty detection"
```

---

## Task 12: Permissions update

**Files:**
- Modify: `src/lib/git/permissions.ts`
- Modify: `src/lib/git/permissions.test.ts`

- [ ] **Step 1: Update tests**

In `permissions.test.ts`, change the developer (≥30) expectations:

```ts
it("developer (30)+: edits AND push enabled", () => {
  const p = mapGitlabAccessLevel(30);
  expect(p.canEditContent).toBe(true);
  expect(p.canEditComments).toBe(true);
  expect(p.canResolveComments).toBe(true);
  expect(p.canPush).toBe(true);
});

it("reporter (20): comments yes, no edits, no push", () => {
  const p = mapGitlabAccessLevel(20);
  expect(p.canEditContent).toBe(false);
  expect(p.canEditComments).toBe(true);
  expect(p.canPush).toBe(false);
});
```

- [ ] **Step 2: Run to fail**

Run: `npm test -- git/permissions`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Update implementation**

```ts
export function mapGitlabAccessLevel(level: number | undefined): ProjectPermissions {
  const lvl = level ?? 0
  return {
    source: "gitlab",
    canEditContent: lvl >= 30,
    canEditComments: lvl >= 20,
    canResolveComments: lvl >= 30,
    canPush: lvl >= 30,
    accessLevel: level,
  }
}
```

- [ ] **Step 4: Run to pass**

Run: `npm test -- git/permissions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/git/permissions.ts src/lib/git/permissions.test.ts
git commit -m "feat(m13.2): developer access (>=30) unlocks canEditContent and canPush"
```

---

## Task 13: ProjectSyncSettings on ProjectRecord

**Files:**
- Modify: `src/lib/parsers/types.ts`

- [ ] **Step 1: Add the type**

After `ProjectPermissions` add:

```ts
export interface ProjectSyncSettings {
  autoSync: { enabled: boolean; intervalMinutes: number };
}
```

And on `ProjectRecord`:

```ts
  syncSettings?: ProjectSyncSettings;
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/lib/parsers/types.ts
git commit -m "feat(m13.2): add ProjectSyncSettings (autoSync interval) to ProjectRecord"
```

---

## Task 14: Sync engine

**Files:**
- Create: `src/lib/sync/commit-message.ts`
- Create: `src/lib/sync/git-sync.ts`
- Create: `src/lib/sync/git-sync.test.ts`

- [ ] **Step 1: Write commit-message.ts**

```ts
// src/lib/sync/commit-message.ts
export function buildCommitMessage(filesChanged: Array<{ name: string; cellsChanged: number }>): string {
  const totalCells = filesChanged.reduce((n, f) => n + f.cellsChanged, 0)
  const summary = `codex-web: sync ${totalCells} cell${totalCells === 1 ? "" : "s"} across ${filesChanged.length} file${filesChanged.length === 1 ? "" : "s"}`
  const detail = filesChanged
    .filter(f => f.cellsChanged > 0)
    .map(f => `- ${f.name}: ${f.cellsChanged} cell${f.cellsChanged === 1 ? "" : "s"} changed`)
    .join("\n")
  return `${summary}\n\n${detail}`.trim()
}
```

- [ ] **Step 2: Write the failing sync engine test**

Create `git-sync.test.ts`. We'll test using a fake CloneRepo + fake git operations — simplest: stub `isomorphic-git` calls via vitest mocks.

```ts
import "fake-indexeddb/auto"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { syncProject } from "./git-sync"
import * as gitClient from "@/lib/git/clone"
// We'll mock isomorphic-git directly to avoid network.
import * as git from "isomorphic-git"

vi.mock("isomorphic-git", async () => {
  const actual = await vi.importActual<typeof import("isomorphic-git")>("isomorphic-git")
  return {
    ...actual,
    fetch: vi.fn(async () => ({ fetchHead: "abc", fetchHeadDescription: "" })),
    resolveRef: vi.fn(async () => "abc"),
    add: vi.fn(async () => {}),
    commit: vi.fn(async () => "newsha"),
    push: vi.fn(async () => ({ ok: true })),
    statusMatrix: vi.fn(async () => []),
  }
})

describe("syncProject", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns no-changes when project is clean", async () => {
    // Build a project with no dirty files (mock isProjectDirty)
    // Call syncProject, assert status === "no-changes"
    // ... fixture-driven setup elided in this skeleton ...
  })

  it("returns remote-moved when fetched head differs", async () => {
    // ...
  })

  it("returns synced and updates origin.headSha on success", async () => {
    // ...
  })
})
```

(Full test bodies will be longer; keep them focused on observable behavior.)

- [ ] **Step 3: Implement git-sync.ts**

```ts
// src/lib/sync/git-sync.ts
import * as git from "isomorphic-git"
import http from "isomorphic-git/http/web"
import { GIT_CORS_PROXY } from "@/lib/git/clone"
import { openOpfsRepoDir, createOpfsFs, type OpfsFs } from "@/lib/git/opfs-fs"
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"
import { serializeFile, serializeComments } from "@/lib/codex-editor/serialize"
import { isFileDirty } from "./dirty"
import { buildCommitMessage } from "./commit-message"
import { updateProject } from "@/lib/store/project-index"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import * as Y from "yjs"

export type SyncPhase =
  | "idle" | "checking-dirty" | "serializing" | "writing"
  | "committing" | "pushing" | "done" | "error" | "remote-moved"

export interface SyncResult {
  status: "synced" | "no-changes" | "remote-moved" | "error"
  commitSha?: string
  filesWritten?: number
  message?: string
}

export interface SyncOptions {
  signal?: AbortSignal
  onPhase?: (phase: SyncPhase, label?: string) => void
}

function repoKey(p: ProjectRecord): string {
  if (p.origin?.kind !== "git") throw new Error("syncProject: project has no git origin")
  return `${p.origin.gitlabProjectId}-${p.origin.cloneUrl.split("/").slice(-2).join("_")}`
}

export async function syncProject(
  project: ProjectRecord,
  session: FrontierSession,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const { onPhase } = opts
  if (project.origin?.kind !== "git") {
    return { status: "error", message: "Project has no git origin" }
  }

  onPhase?.("checking-dirty")
  const dirHandle = await openOpfsRepoDir(repoKey(project))
  const fs = createOpfsFs(dirHandle)

  // 1) Fetch + compare heads.
  try {
    await git.fetch({
      fs: fs as unknown as git.FsClient, http,
      dir: "/", url: project.origin.cloneUrl,
      ref: project.origin.branch, singleBranch: true, depth: 1,
      corsProxy: GIT_CORS_PROXY,
      onAuth: () => ({ username: "oauth2", password: session.gitlabToken }),
    })
    const remoteHead = await git.resolveRef({
      fs: fs as unknown as git.FsClient, dir: "/",
      ref: `refs/remotes/origin/${project.origin.branch}`,
    })
    if (remoteHead !== project.origin.headSha) {
      onPhase?.("remote-moved")
      return { status: "remote-moved", message: "Remote has new commits. Sync requires Phase 3 (merge)." }
    }
  } catch (e) {
    return { status: "error", message: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` }
  }

  // 2) Load all file docs.
  onPhase?.("serializing")
  const fileHandles = await Promise.all(project.files.map(async f => {
    const handle = loadFileDoc(f.id)
    await new Promise<void>(r => handle.persistence.synced ? r() : handle.persistence.once("synced", () => r()))
    return { ref: f, handle }
  }))

  try {
    // 3) Serialize + write each dirty file.
    onPhase?.("writing")
    const filesChanged: Array<{ name: string; cellsChanged: number }> = []
    let filesWritten = 0
    for (const { ref, handle } of fileHandles) {
      if (!isFileDirty(handle.doc)) continue
      const onDiskPath = findOriginalPath(project, ref.name) ?? `/files/target/${ref.name}.codex`
      const serialized = serializeFile(handle.doc)
      const text = JSON.stringify(serialized, null, 2)
      const existing = await fs.promises.readFile(onDiskPath, { encoding: "utf8" }).catch(() => null) as string | null
      if (existing === text) continue
      await fs.promises.writeFile(onDiskPath, text)
      filesWritten++
      filesChanged.push({ name: ref.name, cellsChanged: countDirtyCells(handle.doc) })
    }

    // Comments
    const allDocs = fileHandles.map(h => h.handle.doc)
    const commentsJson = serializeComments(allDocs)
    const commentsText = JSON.stringify(commentsJson, null, 2)
    const existingComments = await fs.promises.readFile("/.project/comments.json", { encoding: "utf8" }).catch(() => null) as string | null
    if (existingComments !== commentsText && existingComments !== null) {
      await fs.promises.writeFile("/.project/comments.json", commentsText)
      filesWritten++
    }

    if (filesWritten === 0) {
      return { status: "no-changes" }
    }

    // 4) Stage + commit + push.
    onPhase?.("committing")
    await git.add({ fs: fs as unknown as git.FsClient, dir: "/", filepath: "." })
    const commitSha = await git.commit({
      fs: fs as unknown as git.FsClient, dir: "/",
      message: buildCommitMessage(filesChanged),
      author: { name: session.username, email: `${session.username}@frontier` },
    })

    onPhase?.("pushing")
    await git.push({
      fs: fs as unknown as git.FsClient, http, dir: "/",
      remote: "origin", ref: project.origin.branch,
      corsProxy: GIT_CORS_PROXY,
      onAuth: () => ({ username: "oauth2", password: session.gitlabToken }),
    })

    // 5) Bump __lastSyncedHistoryAt on every dirty cell.
    const now = Date.now()
    for (const { handle } of fileHandles) {
      const cellsMap = handle.doc.getMap("cells")
      handle.doc.transact(() => {
        for (const id of cellsMap.keys()) {
          const c = cellsMap.get(id) as Y.Map<unknown> | undefined
          if (!c) continue
          c.set("__lastSyncedHistoryAt", now)
        }
      })
    }

    // 6) Update ProjectRecord.origin.headSha.
    const updated: ProjectRecord = {
      ...project,
      origin: { ...project.origin, headSha: commitSha },
    }
    await updateProject(updated)

    onPhase?.("done")
    return { status: "synced", commitSha, filesWritten }
  } finally {
    for (const { handle } of fileHandles) destroyFileDoc(handle)
  }
}

function findOriginalPath(project: ProjectRecord, fileName: string): string | null {
  if (!project.originalFileListing) return null
  const wanted = `/files/target/${fileName}.codex`
  return wanted in project.originalFileListing ? wanted : null
}

function countDirtyCells(doc: Y.Doc): number {
  const cellsMap = doc.getMap("cells")
  let n = 0
  for (const id of cellsMap.keys()) {
    const c = cellsMap.get(id) as Y.Map<unknown> | undefined
    if (c) {
      // Cheap check duplicating isCellDirty inline to keep the import surface small.
      const lastSynced = (c.get("__lastSyncedHistoryAt") as number) ?? 0
      const histArr = c.get("history") as Y.Array<{ timestamp: string }> | undefined
      if (histArr) {
        for (const e of histArr.toArray()) {
          if (Date.parse(e.timestamp) > lastSynced) { n++; break }
        }
      }
    }
  }
  return n
}
```

- [ ] **Step 4: Run to pass (skeletons OK initially; flesh out as needed)**

Run: `npm test -- sync/git-sync`
Expected: PASS. If not, iterate.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/commit-message.ts src/lib/sync/git-sync.ts src/lib/sync/git-sync.test.ts
git commit -m "feat(m13.2): syncProject (fetch -> serialize -> write -> commit -> push)"
```

---

## Task 15: useSyncProject hook

**Files:**
- Create: `src/hooks/useSyncProject.ts`

- [ ] **Step 1: Implement**

```ts
// src/hooks/useSyncProject.ts
import { useState, useCallback } from "react"
import { syncProject, type SyncPhase, type SyncResult } from "@/lib/sync/git-sync"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"

interface State {
  phase: SyncPhase
  inFlight: boolean
  lastResult: SyncResult | null
}

export function useSyncProject() {
  const [state, setState] = useState<State>({ phase: "idle", inFlight: false, lastResult: null })

  const sync = useCallback(async (project: ProjectRecord, session: FrontierSession) => {
    if (state.inFlight) return state.lastResult
    setState(s => ({ ...s, inFlight: true, phase: "checking-dirty" }))
    const result = await syncProject(project, session, {
      onPhase: phase => setState(s => ({ ...s, phase })),
    })
    setState({ phase: result.status === "synced" ? "done" : result.status === "no-changes" ? "idle" : "error", inFlight: false, lastResult: result })
    return result
  }, [state.inFlight, state.lastResult])

  return { ...state, sync }
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc -b --noEmit
git add src/hooks/useSyncProject.ts
git commit -m "feat(m13.2): useSyncProject hook"
```

---

## Task 16: SyncButton

**Files:**
- Create: `src/components/SyncButton.tsx`
- Modify: `src/components/Toolbar.tsx`

- [ ] **Step 1: Write SyncButton.tsx**

```tsx
import { useEffect, useState } from "react"
import { Cloud, CloudOff, Loader2, AlertTriangle, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useSyncProject } from "@/hooks/useSyncProject"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { isProjectDirty } from "@/lib/sync/dirty"
import type { ProjectRecord } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"

export function SyncButton({ project, onUpdated }: { project: ProjectRecord; onUpdated: (p: ProjectRecord) => void }) {
  const { session } = useFrontierSession()
  const perms = useProjectPermissions(project)
  const { sync, inFlight, phase, lastResult } = useSyncProject()
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let cancelled = false
    const id = window.setInterval(() => {
      isProjectDirty(project).then(d => { if (!cancelled) setDirty(d) })
    }, 3000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [project])

  if (!perms.canPush || !session) return null

  async function onClick() {
    const r = await sync(project, session)
    if (r?.status === "synced") onUpdated({ ...project, origin: { ...project.origin!, headSha: r.commitSha! } })
  }

  if (lastResult?.status === "remote-moved") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-amber-700">
        <CloudOff className="h-3.5 w-3.5" /> Remote moved — sync paused
      </span>
    )
  }

  return (
    <Button size="sm" variant={dirty ? "default" : "ghost"} onClick={onClick} disabled={inFlight}>
      {inFlight ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> :
       lastResult?.status === "error" ? <AlertTriangle className="h-3.5 w-3.5 mr-1 text-destructive" /> :
       dirty ? <Cloud className="h-3.5 w-3.5 mr-1" /> :
       <Check className="h-3.5 w-3.5 mr-1 text-green-600" />}
      {inFlight ? phase : lastResult?.status === "error" ? "Sync failed" : dirty ? "Sync" : "Synced"}
    </Button>
  )
}
```

- [ ] **Step 2: Mount in Toolbar**

In `Toolbar.tsx`, find where the share/snapshot buttons live and insert `<SyncButton project={project} onUpdated={...} />` near them. The toolbar likely receives `project` as a prop already.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/components/SyncButton.tsx src/components/Toolbar.tsx
git commit -m "feat(m13.2): SyncButton in toolbar with dirty/syncing/error/remote-moved states"
```

---

## Task 17: Cmd+S keyboard shortcut

**Files:**
- Modify: `src/components/ProjectWorkspace.tsx`

- [ ] **Step 1: Add a keyboard handler**

Inside `ProjectWorkspace`, when permissions.canPush is true and a session exists, add a `useEffect` that listens for `keydown` with `e.key === "s" && (e.metaKey || e.ctrlKey)`, calls `e.preventDefault()`, and triggers a sync via the same hook.

The cleanest path is to lift `useSyncProject` to `ProjectWorkspace` level, pass its `sync` callback into `SyncButton` as a prop. Refactor accordingly.

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc -b --noEmit
git add src/components/ProjectWorkspace.tsx src/components/SyncButton.tsx
git commit -m "feat(m13.2): Cmd/Ctrl+S triggers sync"
```

---

## Task 18: Auto-sync hook

**Files:**
- Create: `src/hooks/useAutoSync.ts`
- Modify: `src/components/ProjectWorkspace.tsx`

- [ ] **Step 1: Write the hook**

```ts
// src/hooks/useAutoSync.ts
import { useEffect, useRef } from "react"
import { isProjectDirty } from "@/lib/sync/dirty"
import { syncProject } from "@/lib/sync/git-sync"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

export function useAutoSync(project: ProjectRecord | null, session: FrontierSession | null): void {
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!project || !session) return
    const settings = project.syncSettings?.autoSync
    if (!settings?.enabled) return
    const ms = Math.max(60_000, settings.intervalMinutes * 60_000) // floor at 1 min

    const id = window.setInterval(async () => {
      if (inFlightRef.current) return
      const dirty = await isProjectDirty(project)
      if (!dirty) return
      inFlightRef.current = true
      try {
        await syncProject(project, session)
      } finally {
        inFlightRef.current = false
      }
    }, ms)
    return () => window.clearInterval(id)
  }, [project, session])
}
```

- [ ] **Step 2: Mount in ProjectWorkspace**

```tsx
const { session } = useFrontierSession()
useAutoSync(project, session)
```

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc -b --noEmit
git add src/hooks/useAutoSync.ts src/components/ProjectWorkspace.tsx
git commit -m "feat(m13.2): per-project auto-sync interval, dirty-check first"
```

---

## Task 19: ProjectSettings UI for sync

**Files:**
- Modify: `src/components/ProjectSettings.tsx`

- [ ] **Step 1: Read existing structure**

Run: `grep -n "section\|Settings\|export function" src/components/ProjectSettings.tsx | head`

Find a stable insertion point for a new section.

- [ ] **Step 2: Add Git Sync section**

Render only when `project.origin?.kind === "git"`:

```tsx
{project.origin?.kind === "git" && (
  <section className="space-y-3">
    <h3 className="text-sm font-semibold">Git sync</h3>
    <p className="text-xs text-muted-foreground">
      Origin: {project.origin.cloneUrl} (branch: {project.origin.branch})
    </p>
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        id="auto-sync"
        checked={project.syncSettings?.autoSync.enabled ?? false}
        onChange={e => onChange({
          ...project,
          syncSettings: {
            autoSync: {
              enabled: e.target.checked,
              intervalMinutes: project.syncSettings?.autoSync.intervalMinutes ?? 5,
            },
          },
        })}
      />
      <label htmlFor="auto-sync" className="text-sm">Auto-sync every</label>
      <Input
        type="number" min={1} max={60}
        className="h-7 w-16"
        value={project.syncSettings?.autoSync.intervalMinutes ?? 5}
        onChange={e => onChange({
          ...project,
          syncSettings: {
            autoSync: {
              enabled: project.syncSettings?.autoSync.enabled ?? false,
              intervalMinutes: Math.max(1, Number(e.target.value)),
            },
          },
        })}
      />
      <span className="text-sm">minutes (only when there are changes)</span>
    </div>
  </section>
)}
```

Wire whatever the existing settings save mechanism is — likely calling `updateProject(project)` from `@/lib/store/project-index`.

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc -b --noEmit
git add src/components/ProjectSettings.tsx
git commit -m "feat(m13.2): per-project auto-sync interval setting in ProjectSettings"
```

---

## Task 20: Round-trip integration test

**Files:**
- Create: `tests/fixtures/codex-editor/full-roundtrip.codex`
- Create: `tests/fixtures/codex-editor/full-roundtrip.source`
- Create: `tests/fixtures/codex-editor/full-roundtrip-metadata.json`
- Create: `tests/fixtures/codex-editor/full-roundtrip-comments.json`
- Create: `tests/integration/round-trip.test.ts`

- [ ] **Step 1: Build a richer fixture**

Make `full-roundtrip.codex` include cells with: attachments, milestone type, cellLabel, isLocked, data.footnotes, multiple edits per cell with validatedBy. Goal: contain enough variety that "byte-identical after import → no-op → serialize" is meaningful.

- [ ] **Step 2: Write the failing integration test**

```ts
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createOpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { importFromOpfs } from "@/lib/importer/git-importer"
import { serializeFile, serializeComments } from "@/lib/codex-editor/serialize"

const FIX = join(__dirname, "../fixtures/codex-editor")

describe("full round-trip lossless", () => {
  it("clone -> import -> noop -> serialize is byte-identical", async () => {
    const root = new MemoryDirectoryHandle("r")
    const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle)
    await fs.promises.mkdir("/r/files/target", { recursive: true })
    await fs.promises.mkdir("/r/.project/sourceTexts", { recursive: true })
    const codex = readFileSync(join(FIX, "full-roundtrip.codex"), "utf8")
    const source = readFileSync(join(FIX, "full-roundtrip.source"), "utf8")
    const meta = readFileSync(join(FIX, "full-roundtrip-metadata.json"), "utf8")
    const comments = readFileSync(join(FIX, "full-roundtrip-comments.json"), "utf8")
    await fs.promises.writeFile("/r/files/target/full-roundtrip.codex", codex)
    await fs.promises.writeFile("/r/.project/sourceTexts/full-roundtrip.source", source)
    await fs.promises.writeFile("/r/metadata.json", meta)
    await fs.promises.writeFile("/r/.project/comments.json", comments)

    const { project, docs } = await importFromOpfs({
      fs, repoDir: "/r",
      origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
      permissions: { source: "gitlab", canEditContent: true, canEditComments: true, canResolveComments: true, canPush: true, accessLevel: 30 },
    })

    const doc = docs[project.files[0].id]
    expect(serializeFile(doc)).toEqual(JSON.parse(codex))
    expect(serializeComments([doc])).toEqual(JSON.parse(comments))
  })
})
```

- [ ] **Step 3: Run and iterate**

Run: `npm test -- round-trip`
Expected: PASS. If anything fails, dig into the specific cell/field that drifts.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/round-trip.test.ts tests/fixtures/codex-editor/full-roundtrip*
git commit -m "test(m13.2): full round-trip lossless integration test"
```

---

## Task 21: Manual smoke test + deploy

- [ ] **Step 1: Run local dev**

```bash
npm run dev
```

- [ ] **Step 2: Manual flow**

1. Import a real codex-editor project (already cloned — re-import to pick up `__source` stash).
2. Edit a cell.
3. Verify SyncButton flips to "Sync" state.
4. Click sync → progress "Pushing…" → "Synced".
5. In a separate terminal, `git clone` the repo and confirm the commit appears with author = your Frontier username.
6. Re-clone in codex-editor desktop and confirm your edit shows up correctly with edit history attribution.
7. Edit another cell, wait 5 minutes, confirm auto-sync fires (look at network tab).
8. Sabotage: in codex-editor desktop, push another commit. In our app, edit and try to sync — confirm "Remote moved" pause UI appears.

- [ ] **Step 3: Deploy**

```bash
npm run deploy
```

- [ ] **Step 4: Re-test against deployed app** at https://codex-web-app.pages.dev.

- [ ] **Step 5: Commit any post-smoke fixes**

---

## Self-Review Notes

**Spec coverage:**
- Lossless via __source stash ✅ (Tasks 4, 7, 9)
- Edit-session collapse → EditHistory entry ✅ (Tasks 6, 7)
- Vendored merge resolvers ✅ (Tasks 1, 2, 3)
- Sync engine with phases ✅ (Task 14)
- Manual sync button + Cmd+S ✅ (Tasks 16, 17)
- Per-project auto-sync ✅ (Tasks 18, 19)
- Permissions update ✅ (Task 12)
- Push failure → remote-moved pause ✅ (Task 14)
- Round-trip CI test ✅ (Task 20)

**Type consistency check:** `EditHistory.timestamp` is `number` (ms epoch) in the codex-editor schema; our `CellHistoryEntry.timestamp` is ISO `string`. The session collapser parses one into the other (Task 6) — ensure all paths agree.

**Risks carried into execution:**
- HTML round-trip: if the test fixture uses `<span>` etc, the round-trip test will fail because our HTML emitter strips them. Fix path documented in spec — extend `serializeText` in `translated-xml.ts` to preserve span+other passthrough tags from `__source.value`. Likely needed in Task 7.
- Comments serializer (Task 9) assumes every thread has a `__source` — Phase 2 doesn't allow new threads. If a user added a thread locally before Phase 2 ships, it will be silently dropped. Document in code.
- File path detection (`findOriginalPath` in Task 14) assumes `<name>.codex` lives at `/files/target/`. True for codex-editor, but verify against the real repo before the smoke test.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-15-codex-web-app-milestone13-phase2.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, spec + quality review, fastest iteration.
**2. Inline Execution** — execute tasks here with checkpoints.

Which approach?
