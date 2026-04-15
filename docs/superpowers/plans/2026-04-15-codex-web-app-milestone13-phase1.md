# M13 Phase 1 — Read-only Git Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user log into Frontier, pick a codex-editor repo, clone it to OPFS, parse it into our Y.Doc model, and open it as a locked project.

**Architecture:** Four subsystems — Frontier auth client (password → JWT + GitLab PAT), git client (isomorphic-git + OPFS-fs shim + CORS-proxy Worker), codex-editor parser (JSON → our types), importer (orchestrates clone → parse → materialize Y.Docs → persist ProjectRecord).

**Tech Stack:** `isomorphic-git`, OPFS, Yjs, React 19, TypeScript, Vitest, Cloudflare Workers. Reference: spec at `docs/superpowers/specs/2026-04-15-codex-web-app-milestone13-phase1-git-import-design.md`.

---

## File Structure

**New files:**
```
src/lib/codex-editor/
  types.ts                  # codex-editor TypeScript interfaces (copied verbatim)
  parse-codex.ts            # .codex / .source JSON → CodexCell[]
  parse-metadata.ts         # metadata.json → CodexProjectMetadata
  parse-comments.ts         # .project/comments.json → our CommentThread[]
  pair-cells.ts             # zip source+target by cell id → TranslatableString[]
  map-history.ts            # EditHistory[] → CellHistoryEntry[]
  index.ts                  # re-exports

src/lib/frontier/
  auth.ts                   # login, session persistence
  api.ts                    # listGroups, listProjects, fetchRepoPermissions
  session-store.ts          # IDB-backed session persistence
  types.ts                  # FrontierSession, GitlabProject, etc.

src/lib/git/
  opfs-fs.ts                # isomorphic-git fs shim over OPFS
  clone.ts                  # cloneRepo wrapper
  permissions.ts            # gitlab access level → ProjectPermissions

src/lib/importer/
  git-importer.ts           # orchestrates clone→parse→materialize
  opfs-paths.ts             # OPFS path helpers

src/hooks/
  useFrontierSession.ts     # session state hook
  useProjectPermissions.ts  # permission gate hook

src/components/git-import/
  GitImportDialog.tsx
  FrontierLoginForm.tsx
  RepoPickerList.tsx
  CloneProgress.tsx

tests/fixtures/codex-editor/
  sample.codex              # small example target file
  sample.source             # matching source file
  metadata.json
  comments.json

cors-proxy/                 # new Cloudflare Worker project
  src/index.ts
  wrangler.toml
  package.json
```

**Modified files:**
```
src/lib/parsers/types.ts             # add ProjectOrigin, ProjectPermissions to ProjectRecord
src/components/ProjectSidebar.tsx    # add "Import from git…" menu entry
src/components/EditorTable.tsx       # gate editing with useProjectPermissions
src/components/CommentsDrawer.tsx    # gate comment add/resolve with perms
src/App.tsx                          # mount GitImportDialog
package.json                         # add isomorphic-git, @isomorphic-git/lightning-fs
```

---

## Task 1: Add dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install isomorphic-git**

```bash
npm install isomorphic-git
```

- [ ] **Step 2: Run typecheck to confirm install**

```bash
npm run build 2>&1 | tail -20
```

Expected: build succeeds (no code using it yet).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(m13): add isomorphic-git dependency"
```

---

## Task 2: Codex-editor type definitions

**Files:**
- Create: `src/lib/codex-editor/types.ts`

- [ ] **Step 1: Write the types file**

```ts
// Mirrored from /Users/ryderwishart/frontierrnd/codex-editor/types/index.d.ts
// Kept minimal to what Phase 1 parses.

export type CodexCellKind = 1 | 2;

export const CodexCellTypes = {
  TEXT: "text",
  PARATEXT: "paratext",
  STYLE: "style",
  MILESTONE: "milestone",
} as const;
export type CodexCellType = typeof CodexCellTypes[keyof typeof CodexCellTypes];

export const EditType = {
  USER_EDIT: "user-edit",
  LLM_EDIT: "llm-edit",
  LLM_GENERATION: "llm-generation",
  INITIAL_IMPORT: "initial-import",
  MERGE: "merge",
  MIGRATION: "migration",
} as const;
export type EditTypeValue = typeof EditType[keyof typeof EditType];

export interface ValidationEntry {
  username: string;
  creationTimestamp: number;
  updatedTimestamp: number;
  isDeleted: boolean;
}

export interface EditHistory {
  author: string;
  timestamp: number;
  type: EditTypeValue;
  editMap: string[];
  value: unknown;
  validatedBy?: ValidationEntry[];
}

export interface CodexData {
  startTime?: number;
  endTime?: number;
  book?: string;
  chapter?: string;
  verse?: string;
  deleted?: boolean;
  originalText?: string;
  globalReferences?: string[];
}

export interface CodexCellMetadata {
  id: string;
  type: CodexCellType;
  edits?: EditHistory[];
  data?: CodexData;
  cellLabel?: string;
  parentId?: string;
  isLocked?: boolean;
}

export interface CodexCell {
  kind: CodexCellKind;
  languageId: string;
  value: string;
  metadata: CodexCellMetadata;
}

export interface CodexNotebookMetadata {
  id: string;
  originalName: string;
  corpusMarker?: string;
  textDirection?: "ltr" | "rtl";
  videoUrl?: string;
  sourceCreatedAt?: string;
  codexLastModified?: string;
  navigation?: unknown[];
  [key: string]: unknown;
}

export interface CodexNotebookFile {
  cells: CodexCell[];
  metadata: CodexNotebookMetadata;
}

// comments.json
export interface CodexComment {
  id: string;
  timestamp: number;
  body: string;
  mode: number;
  deleted: boolean;
  author: { name: string };
}

export interface CodexCellIdGlobalState {
  cellId: string;
  globalReferences?: string[];
  uri?: string;
  fileDisplayName?: string;
  cellLabel?: string;
}

export interface CodexCommentThread {
  id: string;
  cellId: CodexCellIdGlobalState;
  comments: CodexComment[];
  collapsibleState: number;
  canReply: boolean;
  threadTitle?: string;
  deletionEvent?: Array<{ timestamp: number; author: { name: string }; deleted: boolean }>;
  resolvedEvent?: Array<{ timestamp: number; author: { name: string }; resolved: boolean }>;
}

export type CodexCommentsFile = Record<string, CodexCommentThread>;

// Root metadata.json — same shape as CodexNotebookMetadata plus project-level fields.
export interface CodexProjectMetadata {
  projectName?: string;
  sourceLanguage?: { tag: string; refName?: string };
  targetLanguage?: { tag: string; refName?: string };
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc -b --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/codex-editor/types.ts
git commit -m "feat(m13): add codex-editor type definitions"
```

---

## Task 3: Fixtures

**Files:**
- Create: `tests/fixtures/codex-editor/sample.codex`
- Create: `tests/fixtures/codex-editor/sample.source`
- Create: `tests/fixtures/codex-editor/metadata.json`
- Create: `tests/fixtures/codex-editor/comments.json`

- [ ] **Step 1: Write `sample.source`**

```json
{
  "cells": [
    {
      "kind": 2,
      "languageId": "scripture",
      "value": "In the beginning God created the heavens and the earth.",
      "metadata": {
        "id": "GEN 1:1",
        "type": "text",
        "data": { "book": "GEN", "chapter": "1", "verse": "1" }
      }
    },
    {
      "kind": 2,
      "languageId": "scripture",
      "value": "<p>Now the earth was formless and empty.</p>",
      "metadata": {
        "id": "GEN 1:2",
        "type": "text",
        "data": { "book": "GEN", "chapter": "1", "verse": "2" }
      }
    }
  ],
  "metadata": {
    "id": "src-gen",
    "originalName": "Genesis Source"
  }
}
```

- [ ] **Step 2: Write `sample.codex`**

```json
{
  "cells": [
    {
      "kind": 2,
      "languageId": "scripture",
      "value": "<p>Im Anfang schuf Gott Himmel und Erde.</p>",
      "metadata": {
        "id": "GEN 1:1",
        "type": "text",
        "data": { "book": "GEN", "chapter": "1", "verse": "1" },
        "edits": [
          {
            "author": "alice",
            "timestamp": 1700000000000,
            "type": "user-edit",
            "editMap": ["value"],
            "value": "<p>Im Anfang schuf Gott Himmel und Erde.</p>",
            "validatedBy": [
              { "username": "alice", "creationTimestamp": 1700000000000, "updatedTimestamp": 1700000000000, "isDeleted": false }
            ]
          }
        ]
      }
    },
    {
      "kind": 2,
      "languageId": "scripture",
      "value": "<p>Und die Erde war wüst und leer.</p>",
      "metadata": {
        "id": "GEN 1:2",
        "type": "text",
        "data": { "book": "GEN", "chapter": "1", "verse": "2" },
        "edits": [
          {
            "author": "bot",
            "timestamp": 1700000100000,
            "type": "llm-generation",
            "editMap": ["value"],
            "value": "<p>Und die Erde war wüst und leer.</p>"
          }
        ]
      }
    }
  ],
  "metadata": {
    "id": "tgt-gen",
    "originalName": "Genesis Target",
    "videoUrl": "https://example.com/gen.mp4"
  }
}
```

- [ ] **Step 3: Write `metadata.json`**

```json
{
  "projectName": "Sample Genesis",
  "sourceLanguage": { "tag": "en", "refName": "English" },
  "targetLanguage": { "tag": "de", "refName": "German" }
}
```

- [ ] **Step 4: Write `comments.json`**

```json
{
  "t1": {
    "id": "t1",
    "cellId": { "cellId": "GEN 1:1" },
    "comments": [
      {
        "id": "c1",
        "timestamp": 1700001000000,
        "body": "Does 'schuf' feel right here?",
        "mode": 0,
        "deleted": false,
        "author": { "name": "alice" }
      }
    ],
    "collapsibleState": 0,
    "canReply": true
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/codex-editor/
git commit -m "test(m13): add codex-editor sample fixtures"
```

---

## Task 4: Parse codex/source notebook files

**Files:**
- Create: `src/lib/codex-editor/parse-codex.ts`
- Create: `src/lib/codex-editor/parse-codex.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexNotebook } from "./parse-codex";

const FIXTURE_DIR = join(__dirname, "../../../tests/fixtures/codex-editor");

describe("parseCodexNotebook", () => {
  it("parses a .codex file into cells and metadata", () => {
    const raw = readFileSync(join(FIXTURE_DIR, "sample.codex"), "utf8");
    const parsed = parseCodexNotebook(raw);
    expect(parsed.cells).toHaveLength(2);
    expect(parsed.cells[0].metadata.id).toBe("GEN 1:1");
    expect(parsed.cells[0].metadata.edits?.[0].author).toBe("alice");
    expect(parsed.metadata.videoUrl).toBe("https://example.com/gen.mp4");
  });

  it("accepts a .source file (same schema)", () => {
    const raw = readFileSync(join(FIXTURE_DIR, "sample.source"), "utf8");
    const parsed = parseCodexNotebook(raw);
    expect(parsed.cells[0].value).toContain("In the beginning");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseCodexNotebook("{oops")).toThrow(/JSON/i);
  });

  it("throws when cells missing", () => {
    expect(() => parseCodexNotebook('{"metadata":{}}')).toThrow(/cells/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- parse-codex`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
import type { CodexNotebookFile } from "./types";

export function parseCodexNotebook(raw: string): CodexNotebookFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Notebook must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.cells)) {
    throw new Error("Notebook missing 'cells' array");
  }
  if (!obj.metadata || typeof obj.metadata !== "object") {
    throw new Error("Notebook missing 'metadata' object");
  }
  return parsed as CodexNotebookFile;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- parse-codex`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/parse-codex.ts src/lib/codex-editor/parse-codex.test.ts
git commit -m "feat(m13): parse codex-editor notebook files"
```

---

## Task 5: Parse metadata.json

**Files:**
- Create: `src/lib/codex-editor/parse-metadata.ts`
- Create: `src/lib/codex-editor/parse-metadata.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexProjectMetadata } from "./parse-metadata";

const FIXTURE_DIR = join(__dirname, "../../../tests/fixtures/codex-editor");

describe("parseCodexProjectMetadata", () => {
  it("parses project metadata", () => {
    const raw = readFileSync(join(FIXTURE_DIR, "metadata.json"), "utf8");
    const meta = parseCodexProjectMetadata(raw);
    expect(meta.projectName).toBe("Sample Genesis");
    expect(meta.sourceLanguage?.tag).toBe("en");
    expect(meta.targetLanguage?.tag).toBe("de");
  });

  it("tolerates unknown fields", () => {
    const meta = parseCodexProjectMetadata('{"projectName":"X","weird":42}');
    expect(meta.projectName).toBe("X");
  });

  it("throws on non-object", () => {
    expect(() => parseCodexProjectMetadata("[]")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- parse-metadata`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
import type { CodexProjectMetadata } from "./types";

export function parseCodexProjectMetadata(raw: string): CodexProjectMetadata {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("metadata.json must be a JSON object");
  }
  return parsed as CodexProjectMetadata;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- parse-metadata`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/parse-metadata.ts src/lib/codex-editor/parse-metadata.test.ts
git commit -m "feat(m13): parse codex-editor project metadata"
```

---

## Task 6: Parse comments.json

**Files:**
- Create: `src/lib/codex-editor/parse-comments.ts`
- Create: `src/lib/codex-editor/parse-comments.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexComments, mapCodexCommentsToThreads } from "./parse-comments";

const FIXTURE_DIR = join(__dirname, "../../../tests/fixtures/codex-editor");

describe("parseCodexComments", () => {
  it("parses threads by id", () => {
    const raw = readFileSync(join(FIXTURE_DIR, "comments.json"), "utf8");
    const threads = parseCodexComments(raw);
    expect(threads.t1.cellId.cellId).toBe("GEN 1:1");
    expect(threads.t1.comments).toHaveLength(1);
  });
});

describe("mapCodexCommentsToThreads", () => {
  it("groups threads by cellId", () => {
    const threads = {
      t1: {
        id: "t1",
        cellId: { cellId: "GEN 1:1" },
        comments: [
          { id: "c1", timestamp: 1700001000000, body: "hi", mode: 0, deleted: false, author: { name: "alice" } },
        ],
        collapsibleState: 0,
        canReply: true,
      },
    };
    const grouped = mapCodexCommentsToThreads(threads);
    expect(grouped["GEN 1:1"]).toHaveLength(1);
    expect(grouped["GEN 1:1"][0].messages[0].author).toBe("alice");
    expect(grouped["GEN 1:1"][0].status).toBe("open");
  });

  it("marks resolved threads", () => {
    const threads = {
      t2: {
        id: "t2",
        cellId: { cellId: "X" },
        comments: [{ id: "c", timestamp: 1, body: "b", mode: 0, deleted: false, author: { name: "a" } }],
        collapsibleState: 0,
        canReply: true,
        resolvedEvent: [{ timestamp: 99, author: { name: "a" }, resolved: true }],
      },
    };
    const grouped = mapCodexCommentsToThreads(threads);
    expect(grouped["X"][0].status).toBe("resolved");
  });

  it("skips deleted threads", () => {
    const threads = {
      t3: {
        id: "t3",
        cellId: { cellId: "Y" },
        comments: [],
        collapsibleState: 0,
        canReply: true,
        deletionEvent: [{ timestamp: 1, author: { name: "a" }, deleted: true }],
      },
    };
    const grouped = mapCodexCommentsToThreads(threads);
    expect(grouped["Y"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- parse-comments`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
import type { CodexCommentsFile, CodexCommentThread } from "./types";
import type { CommentThread, CommentMessage } from "@/lib/parsers/types";

export function parseCodexComments(raw: string): CodexCommentsFile {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("comments.json must be a JSON object");
  }
  return parsed as CodexCommentsFile;
}

function isDeleted(thread: CodexCommentThread): boolean {
  const latest = thread.deletionEvent?.[thread.deletionEvent.length - 1];
  return !!latest?.deleted;
}

function isResolved(thread: CodexCommentThread): boolean {
  const latest = thread.resolvedEvent?.[thread.resolvedEvent.length - 1];
  return !!latest?.resolved;
}

function mapMessage(c: CodexCommentThread["comments"][number]): CommentMessage {
  return {
    id: c.id,
    author: c.author?.name || "unknown",
    authorType: "user",
    text: c.body,
    timestamp: new Date(c.timestamp).toISOString(),
  };
}

export function mapCodexCommentsToThreads(
  file: CodexCommentsFile
): Record<string, CommentThread[]> {
  const out: Record<string, CommentThread[]> = {};
  for (const thread of Object.values(file)) {
    if (isDeleted(thread)) continue;
    const cellId = thread.cellId?.cellId;
    if (!cellId) continue;
    const resolved = isResolved(thread);
    const resolvedEvt = resolved ? thread.resolvedEvent?.[thread.resolvedEvent.length - 1] : undefined;
    const mapped: CommentThread = {
      id: thread.id,
      status: resolved ? "resolved" : "open",
      createdAt: thread.comments[0] ? new Date(thread.comments[0].timestamp).toISOString() : new Date().toISOString(),
      resolvedAt: resolvedEvt ? new Date(resolvedEvt.timestamp).toISOString() : undefined,
      resolvedBy: resolvedEvt?.author?.name,
      createdForTranslated: "",
      messages: thread.comments.filter(c => !c.deleted).map(mapMessage),
    };
    (out[cellId] ??= []).push(mapped);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- parse-comments`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/parse-comments.ts src/lib/codex-editor/parse-comments.test.ts
git commit -m "feat(m13): map codex-editor comments to our thread model"
```

---

## Task 7: Cell pairing

**Files:**
- Create: `src/lib/codex-editor/pair-cells.ts`
- Create: `src/lib/codex-editor/pair-cells.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { pairCells } from "./pair-cells";
import type { CodexCell } from "./types";

function cell(id: string, value: string, extra: Partial<CodexCell["metadata"]> = {}): CodexCell {
  return {
    kind: 2,
    languageId: "scripture",
    value,
    metadata: { id, type: "text", ...extra },
  };
}

describe("pairCells", () => {
  it("zips source and target cells by id", () => {
    const source = [cell("a", "Hello"), cell("b", "World")];
    const target = [cell("a", "Hallo"), cell("b", "Welt")];
    const paired = pairCells(source, target, "sample");
    expect(paired).toHaveLength(2);
    expect(paired[0].id).toBe("a");
    expect(paired[0].original).toBe("Hello");
    expect(paired[0].translated).toBe("Hallo");
    expect(paired[0].group).toBe("sample");
  });

  it("strips HTML in original, preserves html field", () => {
    const source = [cell("a", "<p>Hello <b>world</b></p>")];
    const target = [cell("a", "Hallo")];
    const paired = pairCells(source, target, "x");
    expect(paired[0].original).toBe("Hello world");
    expect(paired[0].originalHtml).toBe("<p>Hello <b>world</b></p>");
  });

  it("derives context from timestamp data", () => {
    const source = [cell("c1", "...", { data: { startTime: 1.5, endTime: 3.25 } })];
    const target = [cell("c1", "...")];
    const paired = pairCells(source, target, "x");
    expect(paired[0].context).toBe("00:00:01.500 --> 00:00:03.250");
  });

  it("derives context from book/chapter/verse", () => {
    const source = [cell("c", "...", { data: { book: "GEN", chapter: "1", verse: "1" } })];
    const target = [cell("c", "...")];
    const paired = pairCells(source, target, "x");
    expect(paired[0].context).toBe("GEN 1:1");
  });

  it("includes orphan target cells with empty original", () => {
    const source: CodexCell[] = [];
    const target = [cell("only-target", "Welt")];
    const paired = pairCells(source, target, "x");
    expect(paired).toHaveLength(1);
    expect(paired[0].original).toBe("");
    expect(paired[0].translated).toBe("Welt");
  });

  it("includes orphan source cells with empty translated", () => {
    const source = [cell("only-source", "Hello")];
    const target: CodexCell[] = [];
    const paired = pairCells(source, target, "x");
    expect(paired).toHaveLength(1);
    expect(paired[0].original).toBe("Hello");
    expect(paired[0].translated).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pair-cells`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
import type { CodexCell } from "./types";
import type { TranslatableString, CellType } from "@/lib/parsers/types";

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function pad(n: number, width: number): string {
  return Math.floor(n).toString().padStart(width, "0");
}

function formatVttTime(sec: number): string {
  const h = pad(sec / 3600, 2);
  const m = pad((sec % 3600) / 60, 2);
  const s = pad(sec % 60, 2);
  const ms = Math.round((sec - Math.floor(sec)) * 1000).toString().padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function contextFor(cell: CodexCell | undefined): string {
  const data = cell?.metadata.data;
  if (!data) return "";
  if (data.startTime !== undefined && data.endTime !== undefined) {
    return `${formatVttTime(data.startTime)} --> ${formatVttTime(data.endTime)}`;
  }
  if (data.book && data.chapter && data.verse) {
    return `${data.book} ${data.chapter}:${data.verse}`;
  }
  return "";
}

function mapType(t: string): CellType {
  if (t === "paratext") return "paratext";
  return "text";
}

export function pairCells(
  source: CodexCell[],
  target: CodexCell[],
  group: string
): TranslatableString[] {
  const sourceById = new Map<string, CodexCell>();
  for (const c of source) sourceById.set(c.metadata.id, c);

  const out: TranslatableString[] = [];
  const seen = new Set<string>();

  for (const t of target) {
    const id = t.metadata.id;
    const s = sourceById.get(id);
    seen.add(id);
    out.push({
      id,
      original: s ? stripHtml(s.value) : "",
      originalHtml: s?.value,
      translated: t.value,
      context: contextFor(s ?? t),
      group,
      type: mapType(t.metadata.type),
    });
  }

  for (const s of source) {
    if (seen.has(s.metadata.id)) continue;
    out.push({
      id: s.metadata.id,
      original: stripHtml(s.value),
      originalHtml: s.value,
      translated: "",
      context: contextFor(s),
      group,
      type: mapType(s.metadata.type),
    });
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pair-cells`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/pair-cells.ts src/lib/codex-editor/pair-cells.test.ts
git commit -m "feat(m13): pair codex-editor source+target cells"
```

---

## Task 8: Map edit history

**Files:**
- Create: `src/lib/codex-editor/map-history.ts`
- Create: `src/lib/codex-editor/map-history.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mapEditHistory } from "./map-history";
import type { EditHistory } from "./types";

describe("mapEditHistory", () => {
  it("maps value-only edits to our CellHistoryEntry", () => {
    const edits: EditHistory[] = [
      { author: "alice", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "v1" },
      { author: "bot", timestamp: 2000, type: "llm-generation", editMap: ["value"], value: "v2" },
    ];
    const out = mapEditHistory(edits);
    expect(out).toHaveLength(2);
    expect(out[0].author).toBe("alice");
    expect(out[0].value).toBe("v1");
    expect(out[0].source).toBe("human");
    expect(out[1].source).toBe("llm");
  });

  it("ignores non-value edits", () => {
    const edits: EditHistory[] = [
      { author: "a", timestamp: 1, type: "user-edit", editMap: ["metadata", "data", "startTime"], value: 5 },
    ];
    expect(mapEditHistory(edits)).toHaveLength(0);
  });

  it("marks validated when any non-deleted validator exists", () => {
    const edits: EditHistory[] = [
      { author: "a", timestamp: 1, type: "user-edit", editMap: ["value"], value: "v",
        validatedBy: [{ username: "b", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: false }] },
      { author: "a", timestamp: 2, type: "user-edit", editMap: ["value"], value: "v",
        validatedBy: [{ username: "b", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: true }] },
    ];
    const out = mapEditHistory(edits);
    expect(out[0].validated).toBe(true);
    expect(out[1].validated).toBe(false);
  });

  it("fills empty author with 'git-import'", () => {
    const edits: EditHistory[] = [
      { author: "", timestamp: 1, type: "user-edit", editMap: ["value"], value: "v" },
    ];
    expect(mapEditHistory(edits)[0].author).toBe("git-import");
  });

  it("sorts ascending by timestamp", () => {
    const edits: EditHistory[] = [
      { author: "a", timestamp: 3000, type: "user-edit", editMap: ["value"], value: "c" },
      { author: "a", timestamp: 1000, type: "user-edit", editMap: ["value"], value: "a" },
      { author: "a", timestamp: 2000, type: "user-edit", editMap: ["value"], value: "b" },
    ];
    const out = mapEditHistory(edits);
    expect(out.map(e => e.value)).toEqual(["a", "b", "c"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- map-history`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
import type { EditHistory } from "./types";
import type { CellHistoryEntry } from "@/lib/parsers/types";

const LLM_TYPES = new Set(["llm-edit", "llm-generation"]);

export function mapEditHistory(edits: EditHistory[]): CellHistoryEntry[] {
  const mapped: CellHistoryEntry[] = [];
  for (const e of edits) {
    if (!e.editMap || e.editMap[0] !== "value") continue;
    const validated = !!e.validatedBy?.some(v => !v.isDeleted);
    mapped.push({
      timestamp: new Date(e.timestamp).toISOString(),
      value: typeof e.value === "string" ? e.value : String(e.value ?? ""),
      source: LLM_TYPES.has(e.type) ? "llm" : "human",
      author: e.author || "git-import",
      validated,
    });
  }
  mapped.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return mapped;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- map-history`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/map-history.ts src/lib/codex-editor/map-history.test.ts
git commit -m "feat(m13): map codex-editor edit history"
```

---

## Task 9: Parser barrel export

**Files:**
- Create: `src/lib/codex-editor/index.ts`

- [ ] **Step 1: Write the barrel**

```ts
export * from "./types";
export { parseCodexNotebook } from "./parse-codex";
export { parseCodexProjectMetadata } from "./parse-metadata";
export { parseCodexComments, mapCodexCommentsToThreads } from "./parse-comments";
export { pairCells } from "./pair-cells";
export { mapEditHistory } from "./map-history";
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/codex-editor/index.ts
git commit -m "chore(m13): codex-editor barrel export"
```

---

## Task 10: Extend ProjectRecord with origin + permissions

**Files:**
- Modify: `src/lib/parsers/types.ts`

- [ ] **Step 1: Add the types**

After `VideoAttachment` (around line 157) in `src/lib/parsers/types.ts`, insert:

```ts
export interface ProjectOrigin {
  kind: "git";
  cloneUrl: string;
  gitlabProjectId: number;
  branch: string;
  headSha: string;
  importedAt: string;
}

export interface ProjectPermissions {
  source: "gitlab" | "local";
  canEditContent: boolean;
  canEditComments: boolean;
  canResolveComments: boolean;
  canPush: boolean;
  accessLevel?: number;
}
```

And in `ProjectRecord`, add:

```ts
  origin?: ProjectOrigin;
  permissions?: ProjectPermissions;
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/parsers/types.ts
git commit -m "feat(m13): add ProjectOrigin and ProjectPermissions to ProjectRecord"
```

---

## Task 11: useProjectPermissions hook + local default

**Files:**
- Create: `src/hooks/useProjectPermissions.ts`
- Create: `src/hooks/useProjectPermissions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { defaultLocalPermissions, resolvePermissions } from "./useProjectPermissions";
import type { ProjectRecord } from "@/lib/parsers/types";

describe("resolvePermissions", () => {
  it("returns full-edit defaults for local projects with no permissions", () => {
    const p = resolvePermissions({ permissions: undefined } as ProjectRecord);
    expect(p).toEqual(defaultLocalPermissions);
    expect(p.canEditContent).toBe(true);
  });

  it("returns stored permissions verbatim when present", () => {
    const stored = { source: "gitlab", canEditContent: false, canEditComments: true,
      canResolveComments: false, canPush: false, accessLevel: 20 } as const;
    const p = resolvePermissions({ permissions: stored } as unknown as ProjectRecord);
    expect(p).toBe(stored);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- useProjectPermissions`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
import { useMemo } from "react";
import type { ProjectRecord, ProjectPermissions } from "@/lib/parsers/types";

export const defaultLocalPermissions: ProjectPermissions = {
  source: "local",
  canEditContent: true,
  canEditComments: true,
  canResolveComments: true,
  canPush: false,
};

export function resolvePermissions(project: ProjectRecord | null | undefined): ProjectPermissions {
  return project?.permissions ?? defaultLocalPermissions;
}

export function useProjectPermissions(project: ProjectRecord | null | undefined): ProjectPermissions {
  return useMemo(() => resolvePermissions(project), [project]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- useProjectPermissions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useProjectPermissions.ts src/hooks/useProjectPermissions.test.ts
git commit -m "feat(m13): useProjectPermissions hook"
```

---

## Task 12: Gate editing in EditorTable

**Files:**
- Modify: `src/components/EditorTable.tsx`
- Modify: `src/components/CommentsDrawer.tsx`

Goal: when `permissions.canEditContent` is false, cell editors render read-only; when `permissions.canEditComments` is false, comment inputs hide; when `permissions.canResolveComments` is false, resolve button hides.

- [ ] **Step 1: Read current signatures**

Run: `grep -n "export function EditorTable\|export function CommentsDrawer" src/components/EditorTable.tsx src/components/CommentsDrawer.tsx`

- [ ] **Step 2: Pass permissions prop into EditorTable**

At the top of `EditorTable.tsx`, import:

```ts
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import type { ProjectRecord } from "@/lib/parsers/types"
```

Extend the component's props interface:

```ts
project: ProjectRecord
```

Inside the component:

```ts
const permissions = useProjectPermissions(project)
```

Pass `editable={permissions.canEditContent}` to each `TranslatedEditor` (and any other cell editor), and disable the "accept suggestion" / "LLM complete" buttons when `!permissions.canEditContent`.

- [ ] **Step 3: Gate TranslatedEditor**

In `src/components/TranslatedEditor.tsx`, add `editable?: boolean` prop (default true). Pass into TipTap's `useEditor({ editable, ... })` and update via `editor.setEditable(editable)` inside an effect:

```ts
useEffect(() => { editor?.setEditable(editable) }, [editor, editable])
```

- [ ] **Step 4: Gate CommentsDrawer**

In `CommentsDrawer.tsx`:

```ts
const permissions = useProjectPermissions(project)
```

Hide the "Add comment" textarea and submit when `!permissions.canEditComments`; hide the "Resolve" button when `!permissions.canResolveComments`. Replace with a small muted "Read-only (imported from git)" label when both are false.

- [ ] **Step 5: Update all ProjectWorkspace/EditorTable call sites**

Callers that previously passed `projectId` should now pass the full `project`. Run:

```bash
npx tsc -b --noEmit
```

Fix any resulting type errors.

- [ ] **Step 6: Smoke-test**

Run: `npm test`
Expected: all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/EditorTable.tsx src/components/CommentsDrawer.tsx src/components/TranslatedEditor.tsx src/components/ProjectWorkspace.tsx
git commit -m "feat(m13): gate editing and commenting on project permissions"
```

---

## Task 13: Frontier types

**Files:**
- Create: `src/lib/frontier/types.ts`

- [ ] **Step 1: Write the types**

```ts
export interface FrontierSession {
  jwt: string;
  gitlabToken: string;
  gitlabUrl: string;      // e.g. "https://gitlab.frontierrnd.com"
  username: string;
  createdAt: string;      // ISO
}

export interface FrontierGroup {
  id: number;
  name: string;
  path: string;
  description?: string;
}

export interface GitlabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  description: string | null;
  http_url_to_repo: string;
  default_branch: string;
  last_activity_at: string;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/lib/frontier/types.ts
git commit -m "feat(m13): Frontier session + GitLab project types"
```

---

## Task 14: Session store

**Files:**
- Create: `src/lib/frontier/session-store.ts`
- Create: `src/lib/frontier/session-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { saveSession, loadSession, clearSession } from "./session-store";
import type { FrontierSession } from "./types";

const sample: FrontierSession = {
  jwt: "jwt-x",
  gitlabToken: "glpat-x",
  gitlabUrl: "https://gitlab.example",
  username: "alice",
  createdAt: new Date().toISOString(),
};

describe("session-store", () => {
  beforeEach(async () => { await clearSession(); });

  it("returns null when nothing saved", async () => {
    expect(await loadSession()).toBeNull();
  });

  it("round-trips a session", async () => {
    await saveSession(sample);
    expect(await loadSession()).toEqual(sample);
  });

  it("clears", async () => {
    await saveSession(sample);
    await clearSession();
    expect(await loadSession()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- session-store`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
import { openDB } from "idb";
import type { FrontierSession } from "./types";

const DB = "frontier";
const STORE = "session";
const KEY = "current";

async function db() {
  return openDB(DB, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    },
  });
}

export async function saveSession(s: FrontierSession): Promise<void> {
  const d = await db();
  await d.put(STORE, s, KEY);
}

export async function loadSession(): Promise<FrontierSession | null> {
  const d = await db();
  const s = await d.get(STORE, KEY);
  return (s as FrontierSession | undefined) ?? null;
}

export async function clearSession(): Promise<void> {
  const d = await db();
  await d.delete(STORE, KEY);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- session-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/frontier/session-store.ts src/lib/frontier/session-store.test.ts
git commit -m "feat(m13): Frontier session IndexedDB store"
```

---

## Task 15: Frontier auth client

**Files:**
- Create: `src/lib/frontier/auth.ts`
- Create: `src/lib/frontier/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { login, FrontierAuthError } from "./auth";
import { clearSession, loadSession } from "./session-store";

describe("login", () => {
  beforeEach(async () => { await clearSession(); vi.restoreAllMocks(); });

  it("posts credentials and persists session", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "jwt-1",
        token_type: "bearer",
        gitlab_token: "glpat-1",
        gitlab_url: "https://gitlab.example",
      }), { status: 200 })
    );
    const s = await login({ username: "alice", password: "pw" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.frontierrnd.com/api/v1/auth/token",
      expect.objectContaining({ method: "POST" })
    );
    expect(s.jwt).toBe("jwt-1");
    expect((await loadSession())?.jwt).toBe("jwt-1");
  });

  it("throws FrontierAuthError on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "bad creds" }), { status: 401 })
    );
    await expect(login({ username: "x", password: "y" })).rejects.toBeInstanceOf(FrontierAuthError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- frontier/auth`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
import type { FrontierSession } from "./types";
import { saveSession } from "./session-store";

export const FRONTIER_BASE = "https://api.frontierrnd.com";

export class FrontierAuthError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

interface LoginArgs { username: string; password: string; }

interface LoginResponse {
  access_token: string;
  token_type: string;
  gitlab_token: string;
  gitlab_url: string;
}

export async function login(args: LoginArgs): Promise<FrontierSession> {
  const res = await fetch(`${FRONTIER_BASE}/api/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (res.status === 401) {
    throw new FrontierAuthError("Invalid username or password", 401);
  }
  if (!res.ok) {
    throw new FrontierAuthError(`Login failed (${res.status})`, res.status);
  }
  const data = (await res.json()) as LoginResponse;
  const session: FrontierSession = {
    jwt: data.access_token,
    gitlabToken: data.gitlab_token,
    gitlabUrl: data.gitlab_url.replace(/\/+$/, ""),
    username: args.username,
    createdAt: new Date().toISOString(),
  };
  await saveSession(session);
  return session;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- frontier/auth`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/frontier/auth.ts src/lib/frontier/auth.test.ts
git commit -m "feat(m13): Frontier login client"
```

---

## Task 16: Frontier API (groups + projects)

**Files:**
- Create: `src/lib/frontier/api.ts`
- Create: `src/lib/frontier/api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { listGroups, listGroupProjects } from "./api";
import type { FrontierSession } from "./types";

const session: FrontierSession = {
  jwt: "j", gitlabToken: "g", gitlabUrl: "https://gitlab.example",
  username: "a", createdAt: "",
};

describe("listGroups", () => {
  it("calls portal/groups with bearer jwt", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: 1, name: "G", path: "g" }]), { status: 200 })
    );
    const out = await listGroups(session);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/portal/groups"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer j" }),
      })
    );
    expect(out[0].name).toBe("G");
  });
});

describe("listGroupProjects", () => {
  it("hits gitlab /groups/{id}/projects with PRIVATE-TOKEN", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{
        id: 42, name: "P", path_with_namespace: "g/p", description: null,
        http_url_to_repo: "https://gitlab.example/g/p.git",
        default_branch: "main", last_activity_at: "2026-04-01",
      }]), { status: 200 })
    );
    const out = await listGroupProjects(session, 7);
    expect(spy).toHaveBeenCalledWith(
      "https://gitlab.example/api/v4/groups/7/projects?per_page=100&include_subgroups=true",
      expect.objectContaining({
        headers: expect.objectContaining({ "PRIVATE-TOKEN": "g" }),
      })
    );
    expect(out[0].id).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- frontier/api`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
import { FRONTIER_BASE } from "./auth";
import type { FrontierSession, FrontierGroup, GitlabProject } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function listGroups(session: FrontierSession): Promise<FrontierGroup[]> {
  const res = await fetch(`${FRONTIER_BASE}/api/v1/portal/groups?per_page=100`, {
    headers: { Authorization: `Bearer ${session.jwt}` },
  });
  return json<FrontierGroup[]>(res);
}

export async function listGroupProjects(
  session: FrontierSession, groupId: number
): Promise<GitlabProject[]> {
  const res = await fetch(
    `${session.gitlabUrl}/api/v4/groups/${groupId}/projects?per_page=100&include_subgroups=true`,
    { headers: { "PRIVATE-TOKEN": session.gitlabToken } }
  );
  return json<GitlabProject[]>(res);
}

export async function listAllProjects(session: FrontierSession): Promise<GitlabProject[]> {
  const groups = await listGroups(session);
  const batches = await Promise.all(groups.map(g => listGroupProjects(session, g.id).catch(() => [])));
  const all = batches.flat();
  const seen = new Set<number>();
  return all.filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- frontier/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/frontier/api.ts src/lib/frontier/api.test.ts
git commit -m "feat(m13): Frontier groups + GitLab project listing"
```

---

## Task 17: Map GitLab permissions

**Files:**
- Create: `src/lib/git/permissions.ts`
- Create: `src/lib/git/permissions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mapGitlabAccessLevel } from "./permissions";

describe("mapGitlabAccessLevel", () => {
  it("guest (10): comments disabled, no edits, no resolve", () => {
    const p = mapGitlabAccessLevel(10);
    expect(p).toEqual({
      source: "gitlab", canEditContent: false, canEditComments: false,
      canResolveComments: false, canPush: false, accessLevel: 10,
    });
  });

  it("reporter (20): comments yes, no resolve, no content", () => {
    const p = mapGitlabAccessLevel(20);
    expect(p.canEditComments).toBe(true);
    expect(p.canResolveComments).toBe(false);
    expect(p.canEditContent).toBe(false);
  });

  it("developer (30)+: still no content edits in Phase 1 (push not wired)", () => {
    const p = mapGitlabAccessLevel(30);
    expect(p.canEditContent).toBe(false);
    expect(p.canEditComments).toBe(true);
    expect(p.canResolveComments).toBe(true);
    expect(p.canPush).toBe(false);
  });

  it("undefined defaults to guest", () => {
    const p = mapGitlabAccessLevel(undefined);
    expect(p.canEditComments).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- git/permissions`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
import type { ProjectPermissions } from "@/lib/parsers/types";
import type { GitlabProject } from "@/lib/frontier/types";

export function bestAccessLevel(project: GitlabProject): number | undefined {
  const pa = project.permissions?.project_access?.access_level;
  const ga = project.permissions?.group_access?.access_level;
  if (pa == null && ga == null) return undefined;
  return Math.max(pa ?? 0, ga ?? 0);
}

export function mapGitlabAccessLevel(level: number | undefined): ProjectPermissions {
  const lvl = level ?? 0;
  return {
    source: "gitlab",
    canEditContent: false, // Phase 1 always locks content
    canEditComments: lvl >= 20,
    canResolveComments: lvl >= 30,
    canPush: false,        // Phase 1 never pushes
    accessLevel: level,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- git/permissions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/git/permissions.ts src/lib/git/permissions.test.ts
git commit -m "feat(m13): map GitLab access level to ProjectPermissions"
```

---

## Task 18: OPFS fs shim for isomorphic-git

**Files:**
- Create: `src/lib/git/opfs-fs.ts`
- Create: `src/lib/git/opfs-fs.test.ts`

isomorphic-git uses a subset of Node's `fs.promises`. We back it with OPFS. Tests run in happy-dom which does not have OPFS, so we'll test the surface against a `FileSystemDirectoryHandle` polyfill.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createOpfsFs } from "./opfs-fs";
import { MemoryDirectoryHandle } from "./__test__/mem-fs-handles";

describe("opfs-fs", () => {
  let root: MemoryDirectoryHandle;
  beforeEach(() => { root = new MemoryDirectoryHandle("root"); });

  it("writes and reads a file", async () => {
    const fs = createOpfsFs(root as any);
    await fs.promises.mkdir("/a");
    await fs.promises.writeFile("/a/b.txt", "hello");
    const out = await fs.promises.readFile("/a/b.txt", { encoding: "utf8" });
    expect(out).toBe("hello");
  });

  it("stat reports isFile / isDirectory", async () => {
    const fs = createOpfsFs(root as any);
    await fs.promises.mkdir("/d");
    await fs.promises.writeFile("/d/f", "x");
    const s = await fs.promises.stat("/d/f");
    expect(s.isFile()).toBe(true);
    const ds = await fs.promises.stat("/d");
    expect(ds.isDirectory()).toBe(true);
  });

  it("readdir lists children", async () => {
    const fs = createOpfsFs(root as any);
    await fs.promises.mkdir("/x");
    await fs.promises.writeFile("/x/a", "1");
    await fs.promises.writeFile("/x/b", "2");
    expect((await fs.promises.readdir("/x")).sort()).toEqual(["a", "b"]);
  });

  it("unlink removes files", async () => {
    const fs = createOpfsFs(root as any);
    await fs.promises.writeFile("/f", "x");
    await fs.promises.unlink("/f");
    await expect(fs.promises.readFile("/f")).rejects.toThrow();
  });

  it("readFile with no encoding returns Uint8Array", async () => {
    const fs = createOpfsFs(root as any);
    await fs.promises.writeFile("/f", new Uint8Array([1, 2, 3]));
    const out = await fs.promises.readFile("/f");
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("symlink and readlink reject", async () => {
    const fs = createOpfsFs(root as any);
    await expect(fs.promises.symlink("a", "b")).rejects.toThrow();
    await expect(fs.promises.readlink("b")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Create the in-memory handle helper**

Create `src/lib/git/__test__/mem-fs-handles.ts`:

```ts
// Minimal in-memory stand-in for FileSystemDirectoryHandle / FileSystemFileHandle.
export class MemoryFileHandle {
  kind = "file" as const;
  constructor(public name: string, private data: Uint8Array = new Uint8Array()) {}
  async getFile() {
    const d = this.data;
    return {
      name: this.name,
      size: d.byteLength,
      lastModified: 0,
      async arrayBuffer() { return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength); },
      async text() { return new TextDecoder().decode(d); },
    } as unknown as File;
  }
  async createWritable() {
    const self = this;
    let buf = new Uint8Array();
    return {
      async write(chunk: Uint8Array | string) {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        buf = bytes;
      },
      async close() { self.data = buf; },
    };
  }
}

export class MemoryDirectoryHandle {
  kind = "directory" as const;
  private entries = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();
  constructor(public name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<MemoryDirectoryHandle> {
    let e = this.entries.get(name);
    if (!e) {
      if (!opts?.create) throw new DOMException("NotFound", "NotFoundError");
      e = new MemoryDirectoryHandle(name);
      this.entries.set(name, e);
    }
    if (e.kind !== "directory") throw new DOMException("TypeMismatch", "TypeMismatchError");
    return e;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<MemoryFileHandle> {
    let e = this.entries.get(name);
    if (!e) {
      if (!opts?.create) throw new DOMException("NotFound", "NotFoundError");
      e = new MemoryFileHandle(name);
      this.entries.set(name, e);
    }
    if (e.kind !== "file") throw new DOMException("TypeMismatch", "TypeMismatchError");
    return e;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.entries.delete(name)) throw new DOMException("NotFound", "NotFoundError");
  }

  async *keys() { for (const k of this.entries.keys()) yield k; }
  async *values() { for (const v of this.entries.values()) yield v; }
  async *entries_() { for (const e of this.entries.entries()) yield e; }
  [Symbol.asyncIterator]() { return this.entries_(); }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- opfs-fs`
Expected: FAIL.

- [ ] **Step 4: Write implementation**

```ts
// Minimal fs.promises shim over OPFS for isomorphic-git.
// Supports: readFile, writeFile, unlink, mkdir, rmdir, readdir, stat, lstat, readlink, symlink.

type DirHandle = FileSystemDirectoryHandle;
type FileHandle = FileSystemFileHandle;

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

async function resolveDir(root: DirHandle, parts: string[], opts?: { create?: boolean }): Promise<DirHandle> {
  let dir = root;
  for (const p of parts) {
    dir = await dir.getDirectoryHandle(p, { create: !!opts?.create });
  }
  return dir;
}

async function resolveParent(root: DirHandle, path: string, opts?: { create?: boolean }) {
  const parts = splitPath(path);
  const name = parts.pop();
  if (!name) throw new Error(`Invalid path: ${path}`);
  const parent = await resolveDir(root, parts, opts);
  return { parent, name };
}

interface Stats {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function makeStats(type: "file" | "dir", size: number, mtimeMs: number): Stats {
  return {
    type, size, mtimeMs, ctimeMs: mtimeMs, ino: 0, mode: type === "file" ? 0o100644 : 0o040755,
    uid: 1, gid: 1, dev: 1,
    isFile() { return type === "file"; },
    isDirectory() { return type === "dir"; },
    isSymbolicLink() { return false; },
  };
}

export interface OpfsFs {
  promises: {
    readFile(path: string, opts?: { encoding?: string }): Promise<string | Uint8Array>;
    writeFile(path: string, data: string | Uint8Array | ArrayBuffer, opts?: { encoding?: string }): Promise<void>;
    unlink(path: string): Promise<void>;
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
    rmdir(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<Stats>;
    lstat(path: string): Promise<Stats>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
  };
}

export function createOpfsFs(root: DirHandle): OpfsFs {
  async function getFileHandle(path: string, opts?: { create?: boolean }): Promise<FileHandle> {
    const { parent, name } = await resolveParent(root, path, opts);
    return parent.getFileHandle(name, { create: !!opts?.create });
  }

  return {
    promises: {
      async readFile(path, opts) {
        const handle = await getFileHandle(path);
        const file = await handle.getFile();
        const buf = new Uint8Array(await file.arrayBuffer());
        if (opts?.encoding === "utf8") return new TextDecoder().decode(buf);
        return buf;
      },

      async writeFile(path, data) {
        const handle = await getFileHandle(path, { create: true });
        const writable = await handle.createWritable();
        const bytes = typeof data === "string"
          ? new TextEncoder().encode(data)
          : data instanceof Uint8Array ? data : new Uint8Array(data);
        await writable.write(bytes);
        await writable.close();
      },

      async unlink(path) {
        const { parent, name } = await resolveParent(root, path);
        await parent.removeEntry(name);
      },

      async mkdir(path, opts) {
        const parts = splitPath(path);
        if (opts?.recursive) {
          await resolveDir(root, parts, { create: true });
          return;
        }
        const name = parts.pop();
        if (!name) return;
        const parent = await resolveDir(root, parts);
        await parent.getDirectoryHandle(name, { create: true });
      },

      async rmdir(path) {
        const { parent, name } = await resolveParent(root, path);
        await parent.removeEntry(name);
      },

      async readdir(path) {
        const parts = splitPath(path);
        const dir = await resolveDir(root, parts);
        const out: string[] = [];
        // @ts-expect-error keys() exists on FileSystemDirectoryHandle
        for await (const k of dir.keys()) out.push(k);
        return out;
      },

      async stat(path) {
        const parts = splitPath(path);
        const name = parts.pop();
        if (!name) return makeStats("dir", 0, 0);
        const parent = await resolveDir(root, parts);
        try {
          const fh = await parent.getFileHandle(name);
          const f = await fh.getFile();
          return makeStats("file", f.size, f.lastModified);
        } catch {
          await parent.getDirectoryHandle(name);
          return makeStats("dir", 0, 0);
        }
      },

      async lstat(path) { return this.stat(path); },

      async readlink() { throw new Error("ENOTSUP: symlinks not supported on OPFS"); },

      async symlink() { throw new Error("ENOTSUP: symlinks not supported on OPFS"); },
    },
  };
}

// Open the app's OPFS root and return a subdirectory handle for the given
// dir-name under `/repos/`, creating it if needed.
export async function openOpfsRepoDir(repoKey: string): Promise<DirHandle> {
  const root = await navigator.storage.getDirectory();
  const repos = await root.getDirectoryHandle("repos", { create: true });
  return repos.getDirectoryHandle(repoKey, { create: true });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- opfs-fs`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/git/opfs-fs.ts src/lib/git/opfs-fs.test.ts src/lib/git/__test__/
git commit -m "feat(m13): OPFS fs shim for isomorphic-git"
```

---

## Task 19: CORS proxy Cloudflare Worker

**Files:**
- Create: `cors-proxy/package.json`
- Create: `cors-proxy/wrangler.toml`
- Create: `cors-proxy/src/index.ts`
- Create: `cors-proxy/src/index.test.ts`

- [ ] **Step 1: Write `cors-proxy/package.json`**

```json
{
  "name": "codex-cors-proxy",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: Write `cors-proxy/wrangler.toml`**

```toml
name = "codex-git-proxy"
main = "src/index.ts"
compatibility_date = "2025-01-01"
```

- [ ] **Step 3: Write the failing test**

`cors-proxy/src/index.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import worker from "./index";

describe("cors proxy", () => {
  it("rejects non-frontier host", async () => {
    const req = new Request("https://proxy/https://evil.com/info/refs");
    const res = await worker.fetch(req, {} as any, {} as any);
    expect(res.status).toBe(403);
  });

  it("handles OPTIONS preflight", async () => {
    const req = new Request("https://proxy/https://gitlab.frontierrnd.com/x.git/info/refs", {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Headers": "authorization,content-type" },
    });
    const res = await worker.fetch(req, {} as any, {} as any);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("forwards GET to allowed host", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("packs", { status: 200, headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } })
    );
    const req = new Request(
      "https://proxy/https://gitlab.frontierrnd.com/group/repo.git/info/refs?service=git-upload-pack",
      { headers: { Authorization: "Bearer x" } }
    );
    const res = await worker.fetch(req, {} as any, {} as any);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://gitlab.frontierrnd.com/group/repo.git/info/refs?service=git-upload-pack",
      expect.objectContaining({ method: "GET" })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd cors-proxy && npm install && npm test`
Expected: FAIL.

- [ ] **Step 5: Write implementation**

`cors-proxy/src/index.ts`:

```ts
// Git smart-HTTP CORS shim: forwards GET/POST to an allow-listed host.
// URL shape: https://{this-worker}/{targetUrl including protocol}
// Example:   https://proxy.example/https://gitlab.frontierrnd.com/g/r.git/info/refs?service=git-upload-pack

const ALLOWED_HOSTS = [
  "gitlab.frontierrnd.com",
];

function corsHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization,content-type,user-agent,accept,content-encoding,git-protocol",
    "Access-Control-Expose-Headers":
      "content-type,content-length,content-encoding,www-authenticate",
    ...extra,
  };
}

function isAllowed(target: URL): boolean {
  return ALLOWED_HOSTS.includes(target.host);
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(req.url);
    const targetStr = url.pathname.slice(1) + url.search;
    if (!targetStr.startsWith("http://") && !targetStr.startsWith("https://")) {
      return new Response("Bad proxy URL", { status: 400, headers: corsHeaders() });
    }

    let target: URL;
    try { target = new URL(targetStr); }
    catch { return new Response("Invalid URL", { status: 400, headers: corsHeaders() }); }

    if (!isAllowed(target)) {
      return new Response("Host not allowed", { status: 403, headers: corsHeaders() });
    }

    const fwdHeaders = new Headers();
    for (const [k, v] of req.headers) {
      const key = k.toLowerCase();
      if (["host", "origin", "referer", "cookie", "sec-fetch-site",
           "sec-fetch-mode", "sec-fetch-dest"].includes(key)) continue;
      fwdHeaders.set(k, v);
    }

    const upstream = await fetch(target.toString(), {
      method: req.method,
      headers: fwdHeaders,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      // @ts-expect-error cloudflare-specific
      redirect: "manual",
    });

    const resHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders())) resHeaders.set(k, v as string);

    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  },
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd cors-proxy && npm test`
Expected: PASS.

- [ ] **Step 7: Deploy the worker (manual step; document but don't run in CI)**

```bash
cd cors-proxy
npx wrangler deploy
```

Expected: worker available at `https://codex-git-proxy.<your-subdomain>.workers.dev`.

- [ ] **Step 8: Record the deployed URL**

Add a `cors-proxy/README.md` with one line: "Deployed URL goes in `src/lib/git/clone.ts` as `GIT_CORS_PROXY`."

- [ ] **Step 9: Commit**

```bash
git add cors-proxy/
git commit -m "feat(m13): Cloudflare Worker CORS proxy for git smart-HTTP"
```

---

## Task 20: Clone wrapper

**Files:**
- Create: `src/lib/git/clone.ts`

Unit-testing a real isomorphic-git clone requires an HTTP server — we skip that and instead rely on the integration smoke test (Task 24). The wrapper itself is thin.

- [ ] **Step 1: Write the wrapper**

```ts
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { OpfsFs } from "./opfs-fs";

// Deployed CORS proxy (Task 19). Update if the Worker name changes.
export const GIT_CORS_PROXY = "https://codex-git-proxy.ryderwishart.workers.dev";

export interface CloneArgs {
  fs: OpfsFs;
  dir: string;              // absolute-ish path inside the fs (e.g. "/")
  url: string;              // https://gitlab.frontierrnd.com/group/repo.git
  gitlabToken: string;
  onProgress?: (event: git.ProgressCallback extends (e: infer E) => void ? E : never) => void;
  onMessage?: (message: string) => void;
}

export async function cloneRepo({
  fs, dir, url, gitlabToken, onProgress, onMessage,
}: CloneArgs): Promise<{ headSha: string; branch: string }> {
  await git.clone({
    fs, http,
    dir,
    url,
    corsProxy: `${GIT_CORS_PROXY}/`,
    singleBranch: true,
    depth: 1,
    onAuth: () => ({ username: "oauth2", password: gitlabToken }),
    onProgress,
    onMessage,
  });
  const headSha = await git.resolveRef({ fs, dir, ref: "HEAD" });
  const branch = (await git.currentBranch({ fs, dir, fullname: false })) ?? "main";
  return { headSha, branch };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/git/clone.ts
git commit -m "feat(m13): isomorphic-git clone wrapper"
```

---

## Task 21: OPFS path enumeration helper

**Files:**
- Create: `src/lib/importer/opfs-paths.ts`
- Create: `src/lib/importer/opfs-paths.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createOpfsFs } from "@/lib/git/opfs-fs";
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles";
import { listFilesMatching } from "./opfs-paths";

describe("listFilesMatching", () => {
  let root: MemoryDirectoryHandle;
  beforeEach(() => { root = new MemoryDirectoryHandle("r"); });

  it("finds files matching an extension recursively", async () => {
    const fs = createOpfsFs(root as any);
    await fs.promises.mkdir("/files/target", { recursive: true } as any);
    await fs.promises.writeFile("/files/target/a.codex", "{}");
    await fs.promises.writeFile("/files/target/b.codex", "{}");
    await fs.promises.writeFile("/files/target/c.txt", "{}");

    const found = await listFilesMatching(fs, "/", /\.codex$/);
    expect(found.sort()).toEqual(["/files/target/a.codex", "/files/target/b.codex"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- opfs-paths`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

```ts
import type { OpfsFs } from "@/lib/git/opfs-fs";

export async function listFilesMatching(fs: OpfsFs, startDir: string, re: RegExp): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let names: string[];
    try { names = await fs.promises.readdir(dir); }
    catch { return; }
    for (const name of names) {
      const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
      try {
        const s = await fs.promises.stat(full);
        if (s.isDirectory()) await walk(full);
        else if (s.isFile() && re.test(full)) out.push(full);
      } catch { /* skip */ }
    }
  }
  await walk(startDir);
  return out;
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function joinPath(...parts: string[]): string {
  return "/" + parts.flatMap(p => p.split("/")).filter(Boolean).join("/");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- opfs-paths`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/importer/opfs-paths.ts src/lib/importer/opfs-paths.test.ts
git commit -m "feat(m13): OPFS recursive file listing"
```

---

## Task 22: Git importer (core)

**Files:**
- Create: `src/lib/importer/git-importer.ts`
- Create: `src/lib/importer/git-importer.test.ts`

This test exercises the importer end-to-end without the git step: we pre-populate an OPFS-like fs with the fixture files and call a seam that skips cloning.

- [ ] **Step 1: Add read helpers + seam to importer**

`src/lib/importer/git-importer.ts`:

```ts
import * as Y from "yjs";
import type { OpfsFs } from "@/lib/git/opfs-fs";
import {
  parseCodexNotebook, parseCodexComments, parseCodexProjectMetadata,
  pairCells, mapEditHistory, mapCodexCommentsToThreads,
} from "@/lib/codex-editor";
import type { CodexCell } from "@/lib/codex-editor";
import { listFilesMatching, basename } from "./opfs-paths";
import type {
  ProjectRecord, FileReference, ProjectPermissions, ProjectOrigin,
} from "@/lib/parsers/types";
import { v4 as uuid } from "uuid";

export interface ImportedProject {
  project: ProjectRecord;
  docs: Record<string, Y.Doc>; // keyed by FileReference.id
}

export interface ImportArgs {
  fs: OpfsFs;
  repoDir: string;
  origin: ProjectOrigin;
  permissions: ProjectPermissions;
  onProgress?: (done: number, total: number, label: string) => void;
}

export async function importFromOpfs(args: ImportArgs): Promise<ImportedProject> {
  const { fs, repoDir, onProgress } = args;

  // 1. Parse root metadata.json (best-effort).
  let projectName = "Imported project";
  let sourceLanguage = "en";
  let targetLanguage = "en";
  try {
    const metaRaw = await fs.promises.readFile(`${repoDir}/metadata.json`, { encoding: "utf8" }) as string;
    const meta = parseCodexProjectMetadata(metaRaw);
    if (typeof meta.projectName === "string") projectName = meta.projectName;
    if (meta.sourceLanguage?.tag) sourceLanguage = meta.sourceLanguage.tag;
    if (meta.targetLanguage?.tag) targetLanguage = meta.targetLanguage.tag;
  } catch { /* keep defaults */ }

  // 2. Enumerate .codex target files.
  const codexPaths = await listFilesMatching(fs, `${repoDir}/files/target`, /\.codex$/);
  const sourcePaths = await listFilesMatching(fs, `${repoDir}/.project/sourceTexts`, /\.source$/);

  // Index source notebooks by base name (without extension) for fallback pairing.
  const sourceByStem = new Map<string, CodexCell[]>();
  for (const p of sourcePaths) {
    try {
      const raw = await fs.promises.readFile(p, { encoding: "utf8" }) as string;
      const nb = parseCodexNotebook(raw);
      const stem = basename(p).replace(/\.source$/, "");
      sourceByStem.set(stem, nb.cells);
    } catch { /* skip */ }
  }

  // 3. Parse comments once, keyed by cellId.
  let commentsByCell: Record<string, ReturnType<typeof mapCodexCommentsToThreads>[string]> = {};
  try {
    const raw = await fs.promises.readFile(`${repoDir}/.project/comments.json`, { encoding: "utf8" }) as string;
    commentsByCell = mapCodexCommentsToThreads(parseCodexComments(raw));
  } catch { /* no comments */ }

  // 4. For each .codex, build a Y.Doc.
  const files: FileReference[] = [];
  const docs: Record<string, Y.Doc> = {};
  const total = codexPaths.length;
  for (let i = 0; i < codexPaths.length; i++) {
    const p = codexPaths[i];
    const stem = basename(p).replace(/\.codex$/, "");
    onProgress?.(i, total, stem);

    let nb: Awaited<ReturnType<typeof parseCodexNotebook>>;
    try {
      const raw = await fs.promises.readFile(p, { encoding: "utf8" }) as string;
      nb = parseCodexNotebook(raw);
    } catch { continue; }

    const sourceCells = sourceByStem.get(stem) ?? [];
    const paired = pairCells(sourceCells, nb.cells, stem);

    const fileId = uuid();
    const doc = new Y.Doc();
    doc.transact(() => {
      const cellsArr = doc.getArray("cells");
      cellsArr.push(paired as unknown as object[]);

      const historyMap = doc.getMap<Y.Array<unknown>>("history");
      for (const c of nb.cells) {
        if (!c.metadata.edits?.length) continue;
        const entries = mapEditHistory(c.metadata.edits);
        if (!entries.length) continue;
        const arr = new Y.Array();
        arr.push(entries as unknown as object[]);
        historyMap.set(c.metadata.id, arr);
      }

      const commentsMap = doc.getMap<Y.Array<unknown>>("comments");
      for (const c of paired) {
        const threads = commentsByCell[c.id];
        if (!threads?.length) continue;
        const arr = new Y.Array();
        arr.push(threads as unknown as object[]);
        commentsMap.set(c.id, arr);
      }

      const metaMap = doc.getMap("meta");
      if (nb.metadata.videoUrl) {
        metaMap.set("videoUrl", nb.metadata.videoUrl);
        if (nb.metadata.originalName) metaMap.set("videoFileName", nb.metadata.originalName);
      }
    });

    docs[fileId] = doc;
    files.push({
      id: fileId,
      name: stem,
      type: "txt", // TODO M13.2 — infer from content when USFM/subtitle signals available
      createdAt: new Date().toISOString(),
      cellCount: paired.length,
    });
  }
  onProgress?.(total, total, "done");

  const project: ProjectRecord = {
    id: uuid(),
    name: projectName,
    sourceLanguage,
    targetLanguage,
    createdAt: new Date().toISOString(),
    files,
    members: [],
    origin: args.origin,
    permissions: args.permissions,
  };

  return { project, docs };
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOpfsFs } from "@/lib/git/opfs-fs";
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles";
import { importFromOpfs } from "./git-importer";

const FIX = join(__dirname, "../../../tests/fixtures/codex-editor");

function readFix(name: string) { return readFileSync(join(FIX, name), "utf8"); }

describe("importFromOpfs", () => {
  it("builds a ProjectRecord and Y.Docs from codex-editor files", async () => {
    const root = new MemoryDirectoryHandle("r");
    const fs = createOpfsFs(root as any);
    await fs.promises.mkdir("/repo/files/target", { recursive: true } as any);
    await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true } as any);
    await fs.promises.writeFile("/repo/metadata.json", readFix("metadata.json"));
    await fs.promises.writeFile("/repo/files/target/sample.codex", readFix("sample.codex"));
    await fs.promises.writeFile("/repo/.project/sourceTexts/sample.source", readFix("sample.source"));
    await fs.promises.writeFile("/repo/.project/comments.json", readFix("comments.json"));

    const { project, docs } = await importFromOpfs({
      fs, repoDir: "/repo",
      origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
      permissions: { source: "gitlab", canEditContent: false, canEditComments: true, canResolveComments: false, canPush: false, accessLevel: 20 },
    });

    expect(project.name).toBe("Sample Genesis");
    expect(project.sourceLanguage).toBe("en");
    expect(project.targetLanguage).toBe("de");
    expect(project.files).toHaveLength(1);
    const doc = docs[project.files[0].id];
    const cells = doc.getArray("cells").toJSON() as any[];
    expect(cells).toHaveLength(2);
    expect(cells[0].original).toContain("In the beginning");
    expect(cells[0].translated).toContain("Im Anfang");
    const history = doc.getMap("history").toJSON() as any;
    expect(history["GEN 1:1"]).toBeDefined();
    expect(history["GEN 1:1"][0].author).toBe("alice");
    const comments = doc.getMap("comments").toJSON() as any;
    expect(comments["GEN 1:1"][0].messages[0].text).toContain("schuf");
    expect(project.permissions?.canEditContent).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify (they should already pass if wired right)**

Run: `npm test -- git-importer`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/importer/git-importer.ts src/lib/importer/git-importer.test.ts
git commit -m "feat(m13): git importer materializes Y.Docs from OPFS"
```

---

## Task 23: Persistence — wire importer output into project index + y-indexeddb

**Files:**
- Modify: `src/lib/importer/git-importer.ts` (add `persistImportedProject`)
- Modify: `src/lib/store/project-index.ts` (ensure it accepts projects with `origin`/`permissions` — just verify types flow)

- [ ] **Step 1: Add persistence function**

At the bottom of `src/lib/importer/git-importer.ts`, append:

```ts
import { IndexeddbPersistence } from "y-indexeddb";
import { addProject } from "@/lib/store/project-index";

export async function persistImportedProject(imported: ImportedProject): Promise<void> {
  await addProject(imported.project);
  for (const [fileId, doc] of Object.entries(imported.docs)) {
    const persistence = new IndexeddbPersistence(`file-${fileId}`, doc);
    await persistence.whenSynced;
    persistence.destroy();
  }
}
```

- [ ] **Step 2: Write a smoke test**

Append to `git-importer.test.ts`:

```ts
import "fake-indexeddb/auto";
import { persistImportedProject } from "./git-importer";
import { listProjects } from "@/lib/store/project-index";

it("persists the imported project into the project index", async () => {
  const root = new MemoryDirectoryHandle("r");
  const fs = createOpfsFs(root as any);
  await fs.promises.mkdir("/repo/files/target", { recursive: true } as any);
  await fs.promises.writeFile("/repo/metadata.json", readFix("metadata.json"));
  await fs.promises.writeFile("/repo/files/target/sample.codex", readFix("sample.codex"));

  const imported = await importFromOpfs({
    fs, repoDir: "/repo",
    origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
    permissions: { source: "gitlab", canEditContent: false, canEditComments: false, canResolveComments: false, canPush: false },
  });
  await persistImportedProject(imported);

  const all = await listProjects();
  expect(all.find(p => p.id === imported.project.id)?.name).toBe("Sample Genesis");
});
```

- [ ] **Step 3: Run test**

Run: `npm test -- git-importer`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/importer/git-importer.ts src/lib/importer/git-importer.test.ts
git commit -m "feat(m13): persist imported project to IndexedDB"
```

---

## Task 24: Top-level import entry point

**Files:**
- Modify: `src/lib/importer/git-importer.ts` (add `importFromGitRepo`)

- [ ] **Step 1: Add the entry point**

Append:

```ts
import type { FrontierSession, GitlabProject } from "@/lib/frontier/types";
import { cloneRepo } from "@/lib/git/clone";
import { openOpfsRepoDir, createOpfsFs } from "@/lib/git/opfs-fs";
import { mapGitlabAccessLevel, bestAccessLevel } from "@/lib/git/permissions";

export async function importFromGitRepo(opts: {
  session: FrontierSession;
  project: GitlabProject;
  onPhase?: (phase: "clone" | "parse" | "persist", done: number, total: number, label: string) => void;
}): Promise<ImportedProject> {
  const { session, project, onPhase } = opts;
  const repoKey = `${project.id}-${project.path_with_namespace.replace(/\//g, "_")}`;
  const dirHandle = await openOpfsRepoDir(repoKey);
  const fs = createOpfsFs(dirHandle);

  onPhase?.("clone", 0, 1, project.name);
  const { headSha, branch } = await cloneRepo({
    fs,
    dir: "/",
    url: project.http_url_to_repo,
    gitlabToken: session.gitlabToken,
    onProgress: (p) => onPhase?.("clone", p.loaded ?? 0, p.total ?? 100, p.phase ?? "clone"),
  });
  onPhase?.("clone", 1, 1, "done");

  const permissions = mapGitlabAccessLevel(bestAccessLevel(project));
  const imported = await importFromOpfs({
    fs, repoDir: "/",
    origin: {
      kind: "git",
      cloneUrl: project.http_url_to_repo,
      gitlabProjectId: project.id,
      branch,
      headSha,
      importedAt: new Date().toISOString(),
    },
    permissions,
    onProgress: (done, total, label) => onPhase?.("parse", done, total, label),
  });

  onPhase?.("persist", 0, 1, "saving");
  await persistImportedProject(imported);
  onPhase?.("persist", 1, 1, "done");
  return imported;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/importer/git-importer.ts
git commit -m "feat(m13): top-level importFromGitRepo entry point"
```

---

## Task 25: useFrontierSession hook

**Files:**
- Create: `src/hooks/useFrontierSession.ts`

- [ ] **Step 1: Write the hook**

```ts
import { useEffect, useState, useCallback } from "react";
import { loadSession, clearSession as clear } from "@/lib/frontier/session-store";
import { login as doLogin } from "@/lib/frontier/auth";
import type { FrontierSession } from "@/lib/frontier/types";

export function useFrontierSession() {
  const [session, setSession] = useState<FrontierSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadSession().then(s => { if (!cancelled) { setSession(s); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const s = await doLogin({ username, password });
    setSession(s);
    return s;
  }, []);

  const logout = useCallback(async () => {
    await clear();
    setSession(null);
  }, []);

  return { session, loading, login, logout };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useFrontierSession.ts
git commit -m "feat(m13): useFrontierSession hook"
```

---

## Task 26: Frontier login form

**Files:**
- Create: `src/components/git-import/FrontierLoginForm.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierAuthError } from "@/lib/frontier/auth"

export function FrontierLoginForm({ onSuccess }: { onSuccess: () => void }) {
  const { login } = useFrontierSession()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(username, password)
      onSuccess()
    } catch (err) {
      setError(err instanceof FrontierAuthError ? err.message : "Login failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label htmlFor="f-user">Frontier username or email</Label>
        <Input id="f-user" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" />
      </div>
      <div>
        <Label htmlFor="f-pass">Password</Label>
        <Input id="f-pass" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy || !username || !password} className="w-full">
        {busy ? "Logging in…" : "Log in"}
      </Button>
    </form>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/git-import/FrontierLoginForm.tsx
git commit -m "feat(m13): Frontier login form"
```

---

## Task 27: Repo picker list

**Files:**
- Create: `src/components/git-import/RepoPickerList.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { listAllProjects } from "@/lib/frontier/api"
import type { FrontierSession, GitlabProject } from "@/lib/frontier/types"

interface Props {
  session: FrontierSession
  onPick: (project: GitlabProject) => void
}

export function RepoPickerList({ session, onPick }: Props) {
  const [projects, setProjects] = useState<GitlabProject[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")

  useEffect(() => {
    listAllProjects(session).then(setProjects).catch(e => setError(String(e)))
  }, [session])

  const filtered = useMemo(() => {
    if (!projects) return []
    const q = filter.toLowerCase()
    return projects.filter(p =>
      p.path_with_namespace.toLowerCase().includes(q) ||
      (p.description ?? "").toLowerCase().includes(q)
    )
  }, [projects, filter])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!projects) return (
    <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading projects…
    </div>
  )

  return (
    <div className="space-y-2">
      <Input placeholder="Filter…" value={filter} onChange={e => setFilter(e.target.value)} />
      <ul className="max-h-96 overflow-auto divide-y rounded border">
        {filtered.map(p => (
          <li key={p.id}>
            <Button variant="ghost" className="w-full justify-start h-auto py-2"
              onClick={() => onPick(p)}>
              <div className="flex-1 min-w-0 text-left">
                <p className="text-sm truncate">{p.path_with_namespace}</p>
                {p.description && (
                  <p className="text-xs text-muted-foreground truncate">{p.description}</p>
                )}
              </div>
            </Button>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="p-3 text-sm text-muted-foreground">No matches</li>
        )}
      </ul>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/git-import/RepoPickerList.tsx
git commit -m "feat(m13): repo picker list"
```

---

## Task 28: Clone progress component

**Files:**
- Create: `src/components/git-import/CloneProgress.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { Loader2 } from "lucide-react"

interface Props {
  phase: "clone" | "parse" | "persist"
  done: number
  total: number
  label: string
}

export function CloneProgress({ phase, done, total, label }: Props) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const phaseLabel = { clone: "Cloning", parse: "Parsing files", persist: "Saving" }[phase]
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-sm font-medium">{phaseLabel}</span>
        <span className="text-xs text-muted-foreground truncate">{label}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{done} / {total}</p>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/git-import/CloneProgress.tsx
git commit -m "feat(m13): clone progress UI"
```

---

## Task 29: Git import dialog

**Files:**
- Create: `src/components/git-import/GitImportDialog.tsx`

- [ ] **Step 1: Write the dialog**

```tsx
import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierLoginForm } from "./FrontierLoginForm"
import { RepoPickerList } from "./RepoPickerList"
import { CloneProgress } from "./CloneProgress"
import { importFromGitRepo } from "@/lib/importer/git-importer"
import type { GitlabProject } from "@/lib/frontier/types"

type Stage =
  | { kind: "auth-or-pick" }
  | { kind: "importing"; phase: "clone" | "parse" | "persist"; done: number; total: number; label: string; project: GitlabProject }
  | { kind: "done"; projectId: string }
  | { kind: "error"; message: string }

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (projectId: string) => void
}

export function GitImportDialog({ open, onOpenChange, onImported }: Props) {
  const { session, loading, logout } = useFrontierSession()
  const [stage, setStage] = useState<Stage>({ kind: "auth-or-pick" })

  async function startImport(project: GitlabProject) {
    if (!session) return
    setStage({ kind: "importing", phase: "clone", done: 0, total: 1, label: project.name, project })
    try {
      const imported = await importFromGitRepo({
        session, project,
        onPhase: (phase, done, total, label) =>
          setStage({ kind: "importing", phase, done, total, label, project }),
      })
      setStage({ kind: "done", projectId: imported.project.id })
      onImported(imported.project.id)
    } catch (e) {
      setStage({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import from git</DialogTitle>
        </DialogHeader>

        {loading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}

        {!loading && stage.kind === "auth-or-pick" && (
          session ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Signed in as {session.username}</p>
                <Button size="sm" variant="ghost" onClick={logout}>Log out</Button>
              </div>
              <RepoPickerList session={session} onPick={startImport} />
            </div>
          ) : (
            <FrontierLoginForm onSuccess={() => setStage({ kind: "auth-or-pick" })} />
          )
        )}

        {stage.kind === "importing" && (
          <CloneProgress phase={stage.phase} done={stage.done} total={stage.total} label={stage.label} />
        )}

        {stage.kind === "done" && (
          <div className="space-y-3 p-4">
            <p className="text-sm">Import complete.</p>
            <Button onClick={() => onOpenChange(false)} className="w-full">Close</Button>
          </div>
        )}

        {stage.kind === "error" && (
          <div className="space-y-3 p-4">
            <p className="text-sm text-destructive">{stage.message}</p>
            <Button onClick={() => setStage({ kind: "auth-or-pick" })} className="w-full">Try again</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/git-import/GitImportDialog.tsx
git commit -m "feat(m13): git import dialog orchestration"
```

---

## Task 30: Mount dialog and add menu entry

**Files:**
- Modify: `src/components/ProjectSidebar.tsx` (or wherever project creation lives — confirm in this step)
- Modify: `src/components/Dashboard.tsx` (mount dialog near project list)

- [ ] **Step 1: Identify current project-creation entry point**

Run: `grep -n "ProjectCreateDialog\|Create project\|Import" src/components/Dashboard.tsx src/components/ProjectSidebar.tsx`

- [ ] **Step 2: Add menu item to Dashboard**

In the component that renders "New project", add a sibling button "Import from git…" that toggles a local `gitImportOpen` state:

```tsx
import { GitImportDialog } from "@/components/git-import/GitImportDialog"
// ...
const [gitImportOpen, setGitImportOpen] = useState(false)
// ...
<Button variant="outline" onClick={() => setGitImportOpen(true)}>
  Import from git…
</Button>
<GitImportDialog
  open={gitImportOpen}
  onOpenChange={setGitImportOpen}
  onImported={(projectId) => {
    setGitImportOpen(false)
    navigate(`/project/${projectId}`)
  }}
/>
```

- [ ] **Step 3: Typecheck and run all tests**

Run: `npx tsc -b --noEmit && npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/components/Dashboard.tsx
git commit -m "feat(m13): Import from git menu entry on Dashboard"
```

---

## Task 31: Read-only banner

**Files:**
- Modify: `src/components/ProjectWorkspace.tsx`

- [ ] **Step 1: Add banner**

Near the top of the workspace layout (above EditorTable), show a banner when the project's permissions indicate read-only content:

```tsx
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { Lock } from "lucide-react"
// inside the component:
const perms = useProjectPermissions(project)
const isReadOnly = !perms.canEditContent
// ...
{isReadOnly && (
  <div className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-900">
    <Lock className="h-3.5 w-3.5" />
    Read-only — imported from git. Push is coming in Phase 2.
  </div>
)}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/ProjectWorkspace.tsx
git commit -m "feat(m13): read-only banner for git-imported projects"
```

---

## Task 32: Manual smoke test + deploy

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Manually verify**

1. Open app → Dashboard → click "Import from git…"
2. Log in with real Frontier credentials
3. Pick a small codex-editor project
4. Watch clone → parse → persist progress
5. Verify project appears in list, opens to editor, shows read-only banner
6. Verify cells render with original/translated pairs
7. Verify edit history drawer shows imported entries
8. Verify comments appear on referenced cells
9. Confirm editing is blocked (cells read-only)

- [ ] **Step 3: Deploy cors-proxy and main app**

```bash
cd cors-proxy && npx wrangler deploy && cd ..
npm run deploy
```

- [ ] **Step 4: Re-test against the deployed version**

Open https://codex-web-app.pages.dev and repeat the smoke test.

- [ ] **Step 5: Commit if any fixes were needed**

```bash
git add -A
git commit -m "chore(m13): post-smoke-test fixes"
```

---

## Self-Review Notes

**Spec coverage:**
- Frontier auth ✅ (Task 14-15)
- Repo listing ✅ (Task 16)
- CORS proxy ✅ (Task 19)
- OPFS fs shim ✅ (Task 18)
- Clone ✅ (Task 20)
- All 4 parsers ✅ (Tasks 4-6, 8)
- Cell pairing ✅ (Task 7)
- Permission abstraction ✅ (Tasks 10, 11, 17)
- Import orchestration ✅ (Tasks 22-24)
- UI flow ✅ (Tasks 26-30)
- Read-only gates ✅ (Tasks 12, 31)
- Smoke test ✅ (Task 32)

**Known simplifications (carried forward from spec):**
- `FileReference.type` defaulted to `"txt"` — Task 22 leaves a TODO comment for M13.2 to infer type from content signals.
- Audio attachments and milestone/style cells intentionally out of scope.
- `.vscode/settings.json` / `complete_drafts.txt` ignored.

**Risks to watch during execution:**
- OPFS API surface varies between browsers — the shim may need tweaks for Safari (`createWritable` differs).
- `navigator.storage.getDirectory()` requires secure context — must be tested in production (HTTPS) not just dev.
- Large repos may hit OPFS quota during clone — observed quota usage should surface if import fails.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-15-codex-web-app-milestone13-phase1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, spec + quality review between tasks, fastest iteration.

**2. Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
