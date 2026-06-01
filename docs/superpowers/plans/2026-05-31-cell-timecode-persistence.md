# Cell Timecode Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-cell subtitle timecodes (`start_ms` / `end_ms`) end-to-end — parser → import → D1 → read API → client model — so they survive a reload and a second client.

**Architecture:** Timecodes are stored as integer milliseconds in the `cells` projection (new nullable columns), carried on `source.cell.create` event payloads (the bulk subtitle-import path), returned by the cells read route, and exposed on the client `CellData` as seconds (`startTime`/`endTime`) plus a reconstructed `context` VTT-range string so existing `parseTimestampRange(cell.context)` consumers keep working.

**Tech Stack:** TypeScript, Cloudflare D1 (SQLite) + wrangler migrations, vitest (client: happy-dom; sync-worker: its own vitest), React.

**Prerequisite for:** `subtitle-voice-tag-roundtrip` (VTT export needs these timecodes). Independent of `audio-export-by-character`.

---

### Spec reference
`docs/superpowers/specs/2026-05-31-character-names-audio-export-design.md` §5 "Slice A".

### File map
- Create: `auth-worker/migrations/0022_cell_timecodes.sql`
- Modify: `src/lib/parsers/types.ts` (add `start`/`end` to `TranslatableString`)
- Modify: `src/lib/parsers/subtitle.ts` (parse numeric timecodes)
- Create: `src/lib/parsers/subtitle.timecodes.test.ts`
- Modify: `src/lib/sync/bulk-import.ts` (`BulkImportCell` gains `startMs`/`endMs`)
- Modify: `src/lib/import.ts` (thread `startMs`/`endMs` into bulk cells)
- Modify: `sync-worker/src/events/import-route.ts` (read `startMs`/`endMs` into the `source.cell.create` payload)
- Modify: `sync-worker/src/events/event-projection.ts` (write `start_ms`/`end_ms` in the create case)
- Modify: `sync-worker/src/events/cells-read-route.ts` (`columns`, `CellRowRaw`, `CellRowOut`, `mapRow`)
- Modify: `sync-worker/src/__tests__/helpers/d1-fake.ts` (`CellRow` + `makeCell` + cells-SELECT matcher)
- Create: `sync-worker/src/__tests__/cell-timecodes-projection.test.ts`
- Modify: `sync-worker/src/__tests__/cells-read.test.ts` (assert timecodes round-trip)
- Modify: `src/lib/sync/cells-read-types.ts` (`CellRow` gains `startMs`/`endMs`)
- Modify: `src/hooks/useCells.ts` (`buildCellData` maps timecodes + reconstructs `context`)
- Create: `src/hooks/useCells.timecodes.test.ts`
- Modify: `src/lib/sync/events-emit.ts` + `src/lib/sync/outbox-types.ts` (emit-path parity for the incremental create path)

---

### Task 1: Migration — add timecode columns to `cells`

**Files:**
- Create: `auth-worker/migrations/0022_cell_timecodes.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Migration 0022: per-cell subtitle timecodes
-- Adds numeric cue timing (milliseconds) to the cells projection so subtitle
-- character/VTT export survives reload + sync. Previously the cue timestamp
-- lived only as a transient display string in the client (`context`) and was
-- dropped by the server model. Additive + nullable → non-breaking; existing
-- rows get NULL (= no timecode). Applied to the shared aquilla-db D1.
ALTER TABLE cells ADD COLUMN start_ms INTEGER;
ALTER TABLE cells ADD COLUMN end_ms INTEGER;
```

- [ ] **Step 2: Apply locally**

Run (from `auth-worker/`): `npx wrangler d1 migrations apply aquilla-db --local`
Expected: applies `0022_cell_timecodes.sql` with no error.

- [ ] **Step 3: Commit**

```bash
git add auth-worker/migrations/0022_cell_timecodes.sql
git commit -m "feat(d1): add start_ms/end_ms columns to cells projection"
```

---

### Task 2: Parser — extract numeric timecodes from VTT/SRT

**Files:**
- Modify: `src/lib/parsers/types.ts`
- Modify: `src/lib/parsers/subtitle.ts`
- Test: `src/lib/parsers/subtitle.timecodes.test.ts`

- [ ] **Step 1: Add `start`/`end` to `TranslatableString`**

In `src/lib/parsers/types.ts`, inside `interface TranslatableString` (after `globalReferences?`), add:

```typescript
  /** Cue start/end in seconds, parsed from a subtitle timestamp line. Present
   *  only for `type: "cue"` strings from VTT/SRT import; drives `start_ms`/
   *  `end_ms` persistence. */
  start?: number
  end?: number
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/parsers/subtitle.timecodes.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { extractVttStrings, extractSrtStrings } from "./subtitle"

describe("subtitle timecode extraction", () => {
  it("parses VTT cue start/end into numeric seconds and keeps the raw context", () => {
    const vtt = "WEBVTT\n\n00:00:01.500 --> 00:00:03.250\nHello there\n"
    const [cue] = extractVttStrings(vtt)
    expect(cue.start).toBeCloseTo(1.5)
    expect(cue.end).toBeCloseTo(3.25)
    expect(cue.context).toBe("00:00:01.500 --> 00:00:03.250")
  })

  it("parses SRT comma-millisecond timecodes into seconds", () => {
    const srt = "1\n00:00:02,000 --> 00:00:04,000\nHi\n"
    const [cue] = extractSrtStrings(srt)
    expect(cue.start).toBeCloseTo(2)
    expect(cue.end).toBeCloseTo(4)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/parsers/subtitle.timecodes.test.ts`
Expected: FAIL — `cue.start` is `undefined`.

- [ ] **Step 4: Implement timecode parsing**

In `src/lib/parsers/subtitle.ts`, add this helper after the existing `TIMESTAMP_SRT` constant (top of file):

```typescript
const CUE_RANGE_RE =
  /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/

function parseCueRange(ts: string): { start: number; end: number } | null {
  const m = ts.match(CUE_RANGE_RE)
  if (!m) return null
  const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
  const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000
  return { start, end }
}
```

Then in BOTH `flush()` functions (inside `extractVttStrings` and `extractSrtStrings`), replace the `results.push({ ... })` call with:

```typescript
      const range = parseCueRange(currentTimestamp)
      results.push({
        id: uuid(),
        original: text,
        translated: "",
        context: currentTimestamp,
        group: uuid(),
        type: "cue",
        ...(range ? { start: range.start, end: range.end } : {}),
      })
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/parsers/subtitle.timecodes.test.ts`
Expected: PASS. Also run the existing `npx vitest run src/lib/parsers/subtitle.test.ts` — Expected: still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/parsers/types.ts src/lib/parsers/subtitle.ts src/lib/parsers/subtitle.timecodes.test.ts
git commit -m "feat(import): parse numeric cue timecodes from VTT/SRT"
```

---

### Task 3: Thread timecodes through the client bulk-import payload

**Files:**
- Modify: `src/lib/sync/bulk-import.ts:21-30`
- Modify: `src/lib/import.ts:211-227`
- Test: `src/lib/import.timecodes.test.ts` (new)

- [ ] **Step 1: Extend `BulkImportCell`**

In `src/lib/sync/bulk-import.ts`, add to the `BulkImportCell` interface (after `canonicalRef?: string`):

```typescript
  /** Cue start/end in milliseconds (subtitle import). Persisted to the cells
   *  projection so VTT/character export survives reload. */
  startMs?: number
  endMs?: number
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/import.timecodes.test.ts`. (Adjust the import of the cell-building helper to whatever `src/lib/import.ts` exports for building `BulkImportCell[]` from parsed strings; if only the higher-level function is exported, test through it.)

```typescript
import { describe, it, expect } from "vitest"
import { buildBulkCells } from "./import" // export this helper in Step 3 if not already exported

describe("buildBulkCells timecodes", () => {
  it("maps parsed cue seconds to integer startMs/endMs", () => {
    const cells = buildBulkCells([
      { id: "", original: "Hi", translated: "", context: "", group: "g1", type: "cue", start: 1.5, end: 3.25 },
    ])
    expect(cells[0].startMs).toBe(1500)
    expect(cells[0].endMs).toBe(3250)
  })

  it("omits timecodes for non-cue strings", () => {
    const cells = buildBulkCells([
      { id: "", original: "v", translated: "", context: "", group: "g1", type: "verse" },
    ])
    expect(cells[0].startMs).toBeUndefined()
    expect(cells[0].endMs).toBeUndefined()
  })
})
```

- [ ] **Step 3: Implement the threading**

In `src/lib/import.ts`, locate the cell-building loop (around lines 211-227) that pushes `BulkImportCell`s. Extract it into an exported helper if it is currently inline, then add the timecode fields:

```typescript
export function buildBulkCells(strings: TranslatableString[]): BulkImportCell[] {
  const cells: BulkImportCell[] = []
  let prevCellId: string | null = null
  for (const str of strings) {
    const cellId = str.id || uuidv7()
    cells.push({
      id: uuidv7(),
      cellId,
      anchorCellId: prevCellId,
      value: str.original,
      ...(str.originalHtml ? { valueHtml: str.originalHtml } : {}),
      ...(str.type !== undefined ? { type: str.type } : {}),
      ...(str.group ? { canonicalRef: str.group } : {}),
      ...(str.start !== undefined ? { startMs: Math.round(str.start * 1000) } : {}),
      ...(str.end !== undefined ? { endMs: Math.round(str.end * 1000) } : {}),
    })
    prevCellId = cellId
  }
  return cells
}
```

Replace the original inline loop with a call to `buildBulkCells(result.strings)`. Ensure `TranslatableString` and `BulkImportCell` are imported.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/import.timecodes.test.ts`
Expected: PASS. Run `npx vitest run src/lib/import.test.ts` — Expected: still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/bulk-import.ts src/lib/import.ts src/lib/import.timecodes.test.ts
git commit -m "feat(import): thread startMs/endMs into bulk-import cells"
```

---

### Task 4: Server — accept timecodes in `/import` and write them in the projection

**Files:**
- Modify: `sync-worker/src/events/import-route.ts` (the per-cell `source.cell.create` payload builder)
- Modify: `sync-worker/src/events/event-projection.ts:175-254` (create case)
- Test: `sync-worker/src/__tests__/cell-timecodes-projection.test.ts` (new)

- [ ] **Step 1: Write the failing projection test**

Create `sync-worker/src/__tests__/cell-timecodes-projection.test.ts`. Mirror the recording-DB pattern from `cell-audio.test.ts` (lines 19-30): a fake `db` whose `prepare(sql).bind(...args)` pushes `{ sql, args }` onto a `recorded` array. Then drive the create-case projection and assert the cells INSERT carries the new columns.

```typescript
import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts } from "../events/event-projection"
import type { PersistedEvent } from "../events/event-projection" // adjust to the actual exported type name

interface RecordedStmt { sql: string; args: unknown[] }

function makeRecordingDb() {
  const recorded: RecordedStmt[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          recorded.push({ sql: sql.replace(/\s+/g, " ").trim(), args })
          return this
        },
      }
    },
  } as unknown as D1Database
  return { db, recorded }
}

function sourceCreate(): PersistedEvent {
  return {
    id: "e1", schemaVersion: 1, projectId: "p1", fileId: "f1", cellId: "c1",
    parentId: null, kind: "source.cell.create", author: "importer",
    payload: { cellId: "c1", anchorCellId: null, value: "Hello", startMs: 1500, endMs: 3250 },
    clientTs: 1, serverTs: 1000,
  } as unknown as PersistedEvent
}

describe("timecode projection", () => {
  it("writes start_ms/end_ms in the cells INSERT for source.cell.create", () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, sourceCreate(), [])
    const cellsInsert = recorded.find((r) => r.sql.includes("INSERT INTO cells"))
    expect(cellsInsert).toBeTruthy()
    expect(cellsInsert!.sql).toContain("start_ms")
    expect(cellsInsert!.sql).toContain("end_ms")
    expect(cellsInsert!.args).toContain(1500)
    expect(cellsInsert!.args).toContain(3250)
  })
})
```

(Note: `buildEventProjectionStmts(db, event, stmts)` pushes onto and returns the table list; the `stmts` array passed in is where prepared statements land. The recording happens at `.bind()` time regardless. If `buildEventProjectionStmts` signature differs, match the call used in `cell-events.ts` `handleCellEvent`.)

- [ ] **Step 2: Run test to verify it fails**

Run (from `sync-worker/`): `npx vitest run src/__tests__/cell-timecodes-projection.test.ts`
Expected: FAIL — `start_ms` not in the INSERT SQL.

- [ ] **Step 3: Implement — projection create case**

In `sync-worker/src/events/event-projection.ts`, in the `case 'source.cell.create': case 'target.cell.create':` block, read the timecodes from the payload (after the `anchorCellId` line):

```typescript
  const startMs = (p as { startMs?: number }).startMs ?? null
  const endMs = (p as { endMs?: number }).endMs ?? null
```

Then update the cells INSERT: add `start_ms, end_ms` to the column list, two `?` to the VALUES list, `start_ms = excluded.start_ms, end_ms = excluded.end_ms` to the `ON CONFLICT ... DO UPDATE SET`, and `startMs, endMs` to the `.bind(...)` call (in the same positions). The INSERT becomes:

```typescript
      `INSERT INTO cells (
        project_id, file_id, cell_id, side, value, value_html, type,
        canonical_ref, anchor_cell_id, event_id, source_event_id,
        last_editor, last_edit_at, validated, word_count, content_hash,
        start_ms, end_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(project_id, file_id, cell_id, side) DO UPDATE SET
        side           = excluded.side,
        value          = excluded.value,
        value_html     = excluded.value_html,
        type           = excluded.type,
        canonical_ref  = excluded.canonical_ref,
        anchor_cell_id = excluded.anchor_cell_id,
        event_id       = excluded.event_id,
        source_event_id = NULL,
        last_editor    = excluded.last_editor,
        last_edit_at   = excluded.last_edit_at,
        word_count     = excluded.word_count,
        content_hash   = excluded.content_hash,
        start_ms       = excluded.start_ms,
        end_ms         = excluded.end_ms`,
```

and the `.bind(...)` argument list gains `startMs, endMs` at the end (after `hash`):

```typescript
      .bind(
        event.projectId, event.fileId, cellId, side, value, valueHtml, type,
        canonicalRef, anchorCellId, event.id, event.author, event.serverTs,
        wordCount, hash, startMs, endMs,
      ),
```

- [ ] **Step 4: Implement — `/import` route payload**

In `sync-worker/src/events/import-route.ts`, find where each chunk cell is turned into a `source.cell.create` event payload (it already reads `value`, `canonicalRef`, `anchorCellId`, etc. from the cell). Add `startMs`/`endMs` to that payload, mirroring `canonicalRef`:

```typescript
      ...(cell.canonicalRef !== undefined ? { canonicalRef: cell.canonicalRef } : {}),
      ...(cell.startMs !== undefined ? { startMs: cell.startMs } : {}),
      ...(cell.endMs !== undefined ? { endMs: cell.endMs } : {}),
```

(Use the actual variable name for the chunk cell in that file.)

- [ ] **Step 5: Run test to verify it passes**

Run (from `sync-worker/`): `npx vitest run src/__tests__/cell-timecodes-projection.test.ts`
Expected: PASS. Run the full worker suite `npx vitest run` — Expected: still PASS (statement counts unchanged; columns added to existing INSERTs).

- [ ] **Step 6: Commit**

```bash
git add sync-worker/src/events/event-projection.ts sync-worker/src/events/import-route.ts sync-worker/src/__tests__/cell-timecodes-projection.test.ts
git commit -m "feat(sync): persist start_ms/end_ms in cells projection on import"
```

---

### Task 5: Server — return timecodes from the cells read route

**Files:**
- Modify: `sync-worker/src/events/cells-read-route.ts:34-85, 246`
- Modify: `sync-worker/src/__tests__/helpers/d1-fake.ts` (`CellRow`, `makeCell`, cells-SELECT matcher)
- Modify: `sync-worker/src/__tests__/cells-read.test.ts`

- [ ] **Step 1: Write the failing read test**

Add to `sync-worker/src/__tests__/cells-read.test.ts`:

```typescript
  it("returns start_ms/end_ms as startMs/endMs", async () => {
    const db = makeInMemoryD1({
      cells: [
        makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1", start_ms: 1500, end_ms: 3250 }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=source",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ startMs: number | null; endMs: number | null }> }
    expect(body.cells[0].startMs).toBe(1500)
    expect(body.cells[0].endMs).toBe(3250)
  })
```

- [ ] **Step 2: Update the D1 fake so seeding works**

In `sync-worker/src/__tests__/helpers/d1-fake.ts`: add `start_ms?: number | null` and `end_ms?: number | null` to the `CellRow` interface (around line 68-86), and to the `makeCell` helper's defaults (so seeded cells carry them). Then update the cells-SELECT branch in `execSql` to include the two new columns in the row objects it returns (find the branch matching `FROM cells WHERE project_id = ?` and add `start_ms: c.start_ms ?? null, end_ms: c.end_ms ?? null` to the mapped output, alongside `canonical_ref`).

- [ ] **Step 3: Run test to verify it fails**

Run (from `sync-worker/`): `npx vitest run src/__tests__/cells-read.test.ts`
Expected: FAIL — `startMs` is `undefined`.

- [ ] **Step 4: Implement the read route changes**

In `sync-worker/src/events/cells-read-route.ts`:
- Add to the `columns` string (line ~246): append `, start_ms, end_ms`.
- Add to `CellRowRaw`: `start_ms: number | null` and `end_ms: number | null`.
- Add to `CellRowOut`: `startMs: number | null` and `endMs: number | null`.
- Add to `mapRow`'s returned object: `startMs: row.start_ms, endMs: row.end_ms,`.

- [ ] **Step 5: Run test to verify it passes**

Run (from `sync-worker/`): `npx vitest run src/__tests__/cells-read.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sync-worker/src/events/cells-read-route.ts sync-worker/src/__tests__/helpers/d1-fake.ts sync-worker/src/__tests__/cells-read.test.ts
git commit -m "feat(sync): expose startMs/endMs from the cells read route"
```

---

### Task 6: Client — map timecodes onto `CellData` and reconstruct `context`

**Files:**
- Modify: `src/lib/sync/cells-read-types.ts:38-58` (`CellRow`)
- Modify: `src/hooks/useCells.ts:130-183` (`buildCellData`)
- Test: `src/hooks/useCells.timecodes.test.ts` (new)

- [ ] **Step 1: Extend the client `CellRow`**

In `src/lib/sync/cells-read-types.ts`, add to `interface CellRow` (after `wordCount`):

```typescript
  /** Cue start/end in milliseconds; null for non-subtitle cells. */
  startMs?: number | null
  endMs?: number | null
```

- [ ] **Step 2: Write the failing test**

Create `src/hooks/useCells.timecodes.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { buildCellData } from "./useCells" // export buildCellData in Step 3 if not already exported
import type { CellRow } from "@/lib/sync/cells-read-types"

function row(over: Partial<CellRow>): CellRow {
  return {
    cellId: "c1", side: "source", value: "Hi", valueHtml: null, type: "cue",
    canonicalRef: null, anchorCellId: null, eventId: "e1", sourceEventId: null,
    lastEditor: null, lastEditAt: 0, validated: false, wordCount: 1, ...over,
  }
}

describe("buildCellData timecodes", () => {
  it("maps startMs/endMs to seconds and rebuilds context as a VTT range", () => {
    const cell = buildCellData("c1", row({ startMs: 1500, endMs: 3250 }), undefined, "f1", "u", 1, undefined)
    expect(cell.startTime).toBeCloseTo(1.5)
    expect(cell.endTime).toBeCloseTo(3.25)
    expect(cell.context).toBe("00:00:01.500 --> 00:00:03.250")
  })

  it("leaves context empty and timecodes undefined when absent", () => {
    const cell = buildCellData("c1", row({}), undefined, "f1", "u", 1, undefined)
    expect(cell.startTime).toBeUndefined()
    expect(cell.context).toBe("")
  })
})
```

- [ ] **Step 3: Implement in `buildCellData`**

In `src/hooks/useCells.ts`, add a local formatter near the top of the module:

```typescript
function fmtVtt(sec: number): string {
  const h = String(Math.floor(sec / 3600)).padStart(2, "0")
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0")
  const s = String(Math.floor(sec % 60)).padStart(2, "0")
  const ms = String(Math.round((sec - Math.floor(sec)) * 1000)).padStart(3, "0")
  return `${h}:${m}:${s}.${ms}`
}
```

Export `buildCellData` (add `export`). Inside it, before the `return`, compute:

```typescript
  const startMs = source?.startMs ?? target?.startMs ?? null
  const endMs = source?.endMs ?? target?.endMs ?? null
  const startTime = startMs != null ? startMs / 1000 : undefined
  const endTime = endMs != null ? endMs / 1000 : undefined
  const cueContext =
    startMs != null && endMs != null ? `${fmtVtt(startMs / 1000)} --> ${fmtVtt(endMs / 1000)}` : ""
```

Then in the returned object replace `context: "",` with `context: cueContext,` and add `startTime, endTime,` to the returned fields.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useCells.timecodes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/cells-read-types.ts src/hooks/useCells.ts src/hooks/useCells.timecodes.test.ts
git commit -m "feat(cells): expose startTime/endTime + rebuild context from persisted timecodes"
```

---

### Task 7: Emit-path parity (incremental create) + typecheck

**Files:**
- Modify: `src/lib/sync/outbox-types.ts:66-103`
- Modify: `src/lib/sync/events-emit.ts:405-448`

- [ ] **Step 1: Extend the outbox payload + emit input**

In `src/lib/sync/outbox-types.ts`, add `startMs?: number; endMs?: number` to the `"source.cell.create"` and `"target.cell.create"` payload shapes.

In `src/lib/sync/events-emit.ts`, add `startMs?: number; endMs?: number` to `SourceCellCreateInput`, and thread them into the `emitSourceCellCreate` payload (mirror the `canonicalRef` spread):

```typescript
      ...(input.startMs !== undefined ? { startMs: input.startMs } : {}),
      ...(input.endMs !== undefined ? { endMs: input.endMs } : {}),
```

- [ ] **Step 2: Typecheck both projects**

Run: `npx tsc -b` (root) — Expected: no errors.
Run (from `sync-worker/`): `npm run type-check` — Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/sync/outbox-types.ts src/lib/sync/events-emit.ts
git commit -m "feat(sync): carry timecodes on the incremental source.cell.create emit path"
```

---

### Final verification

- [ ] Run client tests: `npm test` — Expected: PASS.
- [ ] Run worker tests: `cd sync-worker && npx vitest run` — Expected: PASS.
- [ ] Lint: `npx eslint src/lib/parsers/subtitle.ts src/hooks/useCells.ts` — Expected: clean.
- [ ] **DoD check:** a subtitle-imported cell's `start_ms`/`end_ms` persist in D1, are returned by the read route, and surface on `CellData` as `startTime`/`endTime` + a reconstructed `context` — verified by Tasks 2–6 tests. End-to-end reload behavior is verified by the E2E in the `subtitle-voice-tag-roundtrip` plan.
