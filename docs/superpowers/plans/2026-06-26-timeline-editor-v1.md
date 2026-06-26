# Timeline Editor v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Media lens of a time-ordered file a horizontal, zoomable timeline editor with derived Subtitle/Dialogue/Untimed lanes, a linked-URL video preview as master clock, and drag-to-retime cards.

**Architecture:** Hand-rolled timeline over existing primitives (pointer events like `CombinedBoundaryEditor`; `react-player` for video — already installed). Lanes are *derived* from existing single-source cells by `medium` + timing — no schema change. Retiming writes a new fine-grained `cell.retime` event, optimistic and clock-fenced through the existing outbox. The detail pane reuses the existing `EditorRow`, extracted into its own module.

**Tech Stack:** React + TypeScript, Vitest, event-sourced sync (D1/Postgres projection via `sync-worker`), `react-player`, Tailwind.

**Spec:** [docs/superpowers/specs/2026-06-26-timeline-editor-v1-design.md](../specs/2026-06-26-timeline-editor-v1-design.md)

## Global Constraints

- **No new heavy dependency.** Only `react-player` (already in `package.json`) may be used for video. Hand-roll drag/resize/waveform; reuse `src/components/CellWaveform.tsx`.
- **Units:** `CellData.startTime`/`endTime` are in **seconds**; DB columns `cells.start_ms`/`end_ms` are **milliseconds**. Convert only at the event boundary (`Math.round(sec * 1000)` / `ms / 1000`).
- **Writes are event-sourced.** Emit via `src/lib/sync/events-emit.ts` → outbox → projection. Never raw-INSERT. Retime must be optimistic and clock-fenced via the existing `useCells` write-clock (FRO-247) so the dragged position holds until the projection read confirms.
- **Design taste (locked):** neutral Zinc base + a single desaturated steel-blue accent (`#2b5fa8`) for the Dialogue lane; Subtitle lane neutral. Geist UI font, Geist Mono with tabular figures for all timecodes. Inline SVG icons only — **no emoji/glyphs**. No neon glows; subtle tinted shadows. Motion: staggered card reveal, hover lift, grips-on-hover, breathing playhead, `cubic-bezier(0.16,1,0.3,1)`, animate transform/opacity only.
- **Edit files sequentially** (the formatter hook reverts parallel edits to the same file); verify each change with `git diff`.
- **Deferred — do NOT build:** multi-source-lane schema change, ingest split/re-join, ASR-onto-diarization, AI cleanup, uploaded-video Range streaming, clone-vs-live/template graph, split/merge/create-by-drag, drag-from-untimed-to-assign-timing, snapping, multi-track audio mixdown.

---

### Task 1: `deriveLanes` — partition cells into lanes

**Files:**
- Create: `src/lib/timeline/lanes.ts`
- Test: `src/lib/timeline/lanes.test.ts`

**Interfaces:**
- Consumes: `TimelineSegment`, `hasTiming`, `sortByLens` from `src/lib/timeline/derive.ts`.
- Produces: `deriveLanes(segments): { dialogue: T[]; subtitle: T[]; untimed: T[] }` — timed media → `dialogue`; timed non-media → `subtitle`; any untimed → `untimed`. Timed lanes sorted by `startTime` via `sortByLens(_, 'time')`; `untimed` preserves sequence order via `sortByLens(_, 'sequence')`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { deriveLanes } from "./lanes"

const seg = (o: Partial<{ id: string; startTime: number; endTime: number; medium: "text" | "media"; sequenceIndex: number }>) =>
  ({ medium: "text", ...o }) as any

describe("deriveLanes", () => {
  it("splits timed media into dialogue, timed text into subtitle, untimed into untimed", () => {
    const cells = [
      seg({ id: "a", startTime: 0, endTime: 3, medium: "text" }),
      seg({ id: "b", startTime: 0.4, endTime: 6, medium: "media" }),
      seg({ id: "c", medium: "text", sequenceIndex: 9 }),       // untimed
      seg({ id: "d", startTime: 8, endTime: 12, medium: "text" }),
    ]
    const { subtitle, dialogue, untimed } = deriveLanes(cells)
    expect(subtitle.map((s) => s.id)).toEqual(["a", "d"])
    expect(dialogue.map((s) => s.id)).toEqual(["b"])
    expect(untimed.map((s) => s.id)).toEqual(["c"])
  })

  it("sorts each timed lane by startTime", () => {
    const cells = [
      seg({ id: "late", startTime: 10, endTime: 11, medium: "media" }),
      seg({ id: "early", startTime: 1, endTime: 2, medium: "media" }),
    ]
    expect(deriveLanes(cells).dialogue.map((s) => s.id)).toEqual(["early", "late"])
  })

  it("treats missing medium as text (subtitle lane)", () => {
    const cells = [seg({ id: "x", startTime: 0, endTime: 1, medium: undefined })]
    expect(deriveLanes(cells).subtitle.map((s) => s.id)).toEqual(["x"])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/timeline/lanes.test.ts`
Expected: FAIL — `deriveLanes is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// Timeline editor v1 — derive lanes from single-source cells (no schema change).
// Dialogue lane = timed media cells; Subtitle lane = timed non-media cells;
// Untimed = anything without usable timing. Pure; never mutates input.
import { hasTiming, sortByLens, type TimelineSegment } from "./derive"

export interface Lanes<T extends TimelineSegment> {
  dialogue: T[]
  subtitle: T[]
  untimed: T[]
}

const isMedia = (s: TimelineSegment) => (s.medium ?? "text") === "media"

export function deriveLanes<T extends TimelineSegment>(segments: readonly T[]): Lanes<T> {
  const dialogue: T[] = []
  const subtitle: T[] = []
  const untimed: T[] = []
  for (const s of segments) {
    if (!hasTiming(s)) untimed.push(s)
    else if (isMedia(s)) dialogue.push(s)
    else subtitle.push(s)
  }
  return {
    dialogue: sortByLens(dialogue, "time"),
    subtitle: sortByLens(subtitle, "time"),
    untimed: sortByLens(untimed, "sequence"),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/timeline/lanes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/timeline/lanes.ts src/lib/timeline/lanes.test.ts
git commit -m "feat(timeline): deriveLanes partitions cells into subtitle/dialogue/untimed lanes"
```

---

### Task 2: Timeline scale & windowing utilities

**Files:**
- Create: `src/lib/timeline/scale.ts`
- Test: `src/lib/timeline/scale.test.ts`

**Interfaces:**
- Produces:
  - `secToPx(sec: number, pxPerSec: number): number`
  - `pxToSec(px: number, pxPerSec: number): number`
  - `clampRange(startSec, endSec, minDurSec): { startSec, endSec }` — ensures `end - start >= minDurSec`, both finite, `start >= 0`.
  - `isVisible(startSec, endSec, viewStartSec, viewEndSec): boolean` — half-open intersection (reuse `rangesOverlap` semantics).
  - `ZOOM_MIN = 8`, `ZOOM_MAX = 240`, `ZOOM_DEFAULT = 38` (px per second).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { secToPx, pxToSec, clampRange, isVisible } from "./scale"

describe("scale", () => {
  it("converts seconds<->px round-trip", () => {
    expect(secToPx(4, 38)).toBe(152)
    expect(pxToSec(152, 38)).toBeCloseTo(4)
  })
  it("clampRange enforces min duration, non-negative start, finite", () => {
    expect(clampRange(5, 5.1, 0.3)).toEqual({ startSec: 5, endSec: 5.3 })
    expect(clampRange(-2, 1, 0.3)).toEqual({ startSec: 0, endSec: 1 })
    expect(clampRange(NaN, 1, 0.3)).toEqual({ startSec: 0, endSec: 0.3 })
  })
  it("isVisible is half-open intersection", () => {
    expect(isVisible(0, 3, 2, 8)).toBe(true)
    expect(isVisible(8, 9, 2, 8)).toBe(false) // touches end, excluded
    expect(isVisible(1, 2, 2, 8)).toBe(false) // ends at view start
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/timeline/scale.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// Pure time<->pixel math + visibility windowing for the timeline editor.
export const ZOOM_MIN = 8
export const ZOOM_MAX = 240
export const ZOOM_DEFAULT = 38

export const secToPx = (sec: number, pxPerSec: number) => sec * pxPerSec
export const pxToSec = (px: number, pxPerSec: number) => px / pxPerSec

export function clampRange(startSec: number, endSec: number, minDurSec: number) {
  let s = Number.isFinite(startSec) ? Math.max(0, startSec) : 0
  let e = Number.isFinite(endSec) ? endSec : s
  if (e - s < minDurSec) e = s + minDurSec
  return { startSec: s, endSec: e }
}

export function isVisible(startSec: number, endSec: number, viewStartSec: number, viewEndSec: number) {
  return startSec < viewEndSec && viewStartSec < endSec
}
```

- [ ] **Step 4: Run** `npx vitest run src/lib/timeline/scale.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/timeline/scale.ts src/lib/timeline/scale.test.ts
git commit -m "feat(timeline): time<->px scale + clamp + visibility windowing utils"
```

---

### Task 3: `cell.retime` event (emit + projection)

**Files:**
- Modify: `src/lib/sync/outbox-types.ts` (add payload type + union member)
- Modify: `src/lib/sync/events-emit.ts` (add `emitCellRetime`)
- Modify: `sync-worker/src/events/event-projection.ts` (add `case 'cell.retime'`)
- Test: `src/lib/sync/events-emit.retime.test.ts`; `sync-worker/src/events/event-projection.retime.test.ts` (follow the existing projection test pattern in that dir)

**Interfaces:**
- Produces: `emitCellRetime({ projectId, fileId, cellId, startMs, endMs, author, getToken }): Promise<void>` — emits event type `'cell.retime'` with payload `{ cellId, startMs, endMs }` through the same outbox path as `emitCellAudioAttach` (study that function for the exact param shape and outbox call).
- Projection: updates `cells.start_ms`/`end_ms` for the cell across **both sides**.

- [ ] **Step 1: Add the payload type.** In `src/lib/sync/outbox-types.ts`, locate the event payload map (where `'cell.audio.attach'` etc. are defined) and add:

```ts
'cell.retime': { cellId: string; startMs: number; endMs: number }
```

Add `'cell.retime'` to the event-type union if a separate string union exists.

- [ ] **Step 2: Write the failing emit test**

```ts
import { describe, it, expect, vi } from "vitest"
import { emitCellRetime } from "./events-emit"

describe("emitCellRetime", () => {
  it("emits a cell.retime event with ms timing for the cell", async () => {
    const enqueued: any[] = []
    vi.spyOn(await import("./outbox"), "enqueueEvent").mockImplementation(async (e: any) => { enqueued.push(e) })
    await emitCellRetime({
      projectId: "p1", fileId: "f1", cellId: "c1", startMs: 400, endMs: 6000,
      author: "u", getToken: async () => "t",
    })
    const ev = enqueued.at(-1)
    expect(ev.type).toBe("cell.retime")
    expect(ev.fileId).toBe("f1")
    expect(ev.payload).toMatchObject({ cellId: "c1", startMs: 400, endMs: 6000 })
  })
})
```

> Note: mirror how the existing emit tests mock the outbox in this repo. If `events-emit.ts` calls a differently-named enqueue helper, mock that instead — read `emitCellAudioAttach` first.

- [ ] **Step 3: Run** `npx vitest run src/lib/sync/events-emit.retime.test.ts` → FAIL.

- [ ] **Step 4: Implement `emitCellRetime`** in `src/lib/sync/events-emit.ts`, copying the structure of `emitCellAudioAttach` (event id, `type: 'cell.retime'`, `fileId`, `payload`, author, outbox enqueue + token):

```ts
export async function emitCellRetime(input: {
  projectId: string
  fileId: string
  cellId: string
  startMs: number
  endMs: number
  author: string
  getToken: GetTokenFn
}): Promise<void> {
  // Build + enqueue exactly like emitCellAudioAttach, with:
  //   type: "cell.retime"
  //   fileId: input.fileId
  //   payload: { cellId: input.cellId, startMs: input.startMs, endMs: input.endMs }
}
```

- [ ] **Step 5: Run** the emit test → PASS.

- [ ] **Step 6: Write the failing projection test** (in `sync-worker/.../event-projection.retime.test.ts`, following the existing projection test harness): a `cell.retime` event updates `start_ms`/`end_ms` for BOTH the `source` and `target` rows of `cell_id`, and leaves `value` untouched.

- [ ] **Step 7: Run** the projection test → FAIL.

- [ ] **Step 8: Add the projection case** in `sync-worker/src/events/event-projection.ts` (near the other `case` blocks):

```ts
case 'cell.retime': {
  const p = event.payload as EventPayloads['cell.retime']
  if (!event.fileId) throw new Error(`cell.retime event ${event.id} is missing fileId`)
  stmts.push(
    db.prepare(
      `UPDATE cells SET start_ms = ?, end_ms = ?
         WHERE project_id = ? AND file_id = ? AND cell_id = ?`,
    ).bind(p.startMs, p.endMs, event.projectId, event.fileId, p.cellId),
  )
  break
}
```

> The `WHERE` has no `side` filter, so it updates whichever of source/target rows exist. `value` columns are untouched.

- [ ] **Step 9: Run** the projection test → PASS. Then run the full event-projection suite to confirm no regression: `npx vitest run sync-worker/src/events`.

- [ ] **Step 10: Commit**

```bash
git add src/lib/sync/outbox-types.ts src/lib/sync/events-emit.ts src/lib/sync/events-emit.retime.test.ts sync-worker/src/events/event-projection.ts sync-worker/src/events/event-projection.retime.test.ts
git commit -m "feat(sync): cell.retime event updates both sides' timing (timeline editor)"
```

---

### Task 4: `file.video.set` event (core video URL in file meta)

**Files:**
- Modify: `src/lib/sync/outbox-types.ts` (payload + union)
- Modify: `src/lib/sync/events-emit.ts` (`emitFileVideoSet`)
- Modify: `sync-worker/src/events/event-projection.ts` (`case 'file.video.set'`)
- Modify: `sync-worker/src/events/files-read-route.ts` (surface `coreMediaUrl` from `meta`)
- Modify: `src/lib/parsers/types.ts` (add `coreMediaUrl?: string | null` to `FileReference`)
- Test: `src/lib/sync/events-emit.video.test.ts`; projection test alongside Task 3's.

**Interfaces:**
- Produces: `emitFileVideoSet({ projectId, fileId, coreMediaUrl, author, getToken }): Promise<void>` — `coreMediaUrl: string | null` (null clears). Read back as `FileReference.coreMediaUrl`.

- [ ] **Step 1:** Add payload `'file.video.set': { coreMediaUrl: string | null }` to `outbox-types.ts`.

- [ ] **Step 2: Failing emit test** — `emitFileVideoSet` emits `type: 'file.video.set'`, `fileId`, `payload.coreMediaUrl`. (Mirror Task 3's emit test + mock.)

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement `emitFileVideoSet`** (copy `emitFileRename`'s structure — it is the closest file-level meta-mutating emit).

- [ ] **Step 5: Run** emit test → PASS.

- [ ] **Step 6: Failing projection test** — `file.video.set` merges `coreMediaUrl` into `files.meta` JSON without dropping `orderedBy`/languages; null removes the key. Read it back through `files-read-route` and assert `coreMediaUrl`.

- [ ] **Step 7: Run** → FAIL.

- [ ] **Step 8: Implement projection** in `event-projection.ts` (read existing `meta`, JSON-merge `coreMediaUrl`, write back — model it on the `file.rename`/`file.create` meta handling which already round-trips `meta` JSON):

```ts
case 'file.video.set': {
  const p = event.payload as EventPayloads['file.video.set']
  if (!event.fileId) throw new Error(`file.video.set event ${event.id} is missing fileId`)
  // Read current meta, merge coreMediaUrl (delete key when null), write back.
  // Use the same read-modify-write meta pattern used elsewhere in this file.
  break
}
```

In `files-read-route.ts`, extend the `meta` parse (around the `orderedBy` read, ~lines 63-79) to also expose `coreMediaUrl: meta.coreMediaUrl ?? null`, and add it to the returned row shape (and the `FileReference`-mapping client side).

- [ ] **Step 9: Run** projection + read-route tests → PASS; run `npx vitest run sync-worker/src/events`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(sync): file.video.set stores coreMediaUrl in file meta (timeline preview)"
```

---

### Task 5: Extract `EditorRow` into its own module (refactor, no behaviour change)

**Files:**
- Create: `src/components/editor/EditorRow.tsx` (moved component + `MemoizedRowProps`/`EditorRowProps`)
- Modify: `src/components/EditorTable.tsx` (remove the inline `EditorRow`/`MemoizedRow`, import from the new module)
- Test: existing `EditorTable` tests must still pass.

**Interfaces:**
- Produces: `export function EditorRow(props: EditorRowProps)` and the `EditorRowProps` interface, identical to today's inline definitions (EditorTable.tsx ~line 2089 and the `MemoizedRowProps` interface that follows it).

- [ ] **Step 1: Run the existing EditorTable test green first** to capture the baseline: `npx vitest run src/components/EditorTable*.test.tsx` → PASS (record count).

- [ ] **Step 2: Move the code.** Cut `EditorRow` (and the `MemoizedRow` memo wrapper + `MemoizedRowProps`/`EditorRowProps` types) verbatim from `EditorTable.tsx` into `src/components/editor/EditorRow.tsx`. Add the imports it needs (read its body for referenced symbols; export shared types from their current modules if they were local). Export `EditorRow` (and `MemoizedRow` if EditorTable referenced it by that name).

- [ ] **Step 3: Wire the import.** In `EditorTable.tsx`, replace the removed definitions with `import { EditorRow, MemoizedRow } from "@/components/editor/EditorRow"` (match whatever the table actually renders). Resolve any now-unused imports.

- [ ] **Step 4: Typecheck + tests.** Run `npx tsc -p tsconfig.app.json --noEmit` and `npx vitest run src/components/EditorTable*.test.tsx`. Expected: typecheck clean, same test count PASS as Step 1.

- [ ] **Step 5: Verify no behavioural drift** with `git diff --stat` (should be a move + import, not logic changes).

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/EditorRow.tsx src/components/EditorTable.tsx
git commit -m "refactor(editor): extract EditorRow into its own module for timeline reuse"
```

---

### Task 6: `TimelineCard` — render + drag-move + edge-resize

**Files:**
- Create: `src/components/timeline/TimelineCard.tsx`
- Test: `src/components/timeline/TimelineCard.test.tsx`

**Interfaces:**
- Consumes: `secToPx`, `pxToSec`, `clampRange` (Task 2); `CellData`.
- Produces: `TimelineCard` with props:
```ts
interface TimelineCardProps {
  cell: CellData
  pxPerSec: number
  laneStartSec: number               // left edge of the track in seconds (usually 0)
  variant: "subtitle" | "dialogue"
  selected: boolean
  editable: boolean
  onSelect(cellId: string): void
  /** Called once on pointer-up with the final seconds; parent converts to ms + emits. */
  onRetime(cellId: string, startSec: number, endSec: number): void
}
```
- Behaviour: absolutely positioned (`left = secToPx(startTime - laneStartSec)`, `width = secToPx(endTime - startTime)`). Pointer-drag the body → move both bounds; drag left/right grip → change that bound only. Live preview via local transform during drag; commit via `onRetime` on pointer-up. `editable === false` disables grips + body drag (select still works). Minimum duration `0.2s` via `clampRange`.

- [ ] **Step 1: Failing test** (jsdom + pointer events; mirror existing component test setup):

```tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TimelineCard } from "./TimelineCard"

const cell = (o: any) => ({ id: "c1", startTime: 1, endTime: 3, medium: "media", ...o }) as any

describe("TimelineCard", () => {
  it("positions by time", () => {
    render(<TimelineCard cell={cell({})} pxPerSec={40} laneStartSec={0} variant="dialogue"
      selected={false} editable onSelect={() => {}} onRetime={() => {}} />)
    const el = screen.getByTestId("tl-card-c1")
    expect(el).toHaveStyle({ left: "40px", width: "80px" }) // 1s*40, (3-1)s*40
  })
  it("calls onSelect on click", () => {
    const onSelect = vi.fn()
    render(<TimelineCard cell={cell({})} pxPerSec={40} laneStartSec={0} variant="dialogue"
      selected={false} editable onSelect={onSelect} onRetime={() => {}} />)
    fireEvent.click(screen.getByTestId("tl-card-c1"))
    expect(onSelect).toHaveBeenCalledWith("c1")
  })
  it("emits new bounds after dragging the body (move)", () => {
    const onRetime = vi.fn()
    render(<TimelineCard cell={cell({})} pxPerSec={40} laneStartSec={0} variant="dialogue"
      selected editable onSelect={() => {}} onRetime={onRetime} />)
    const el = screen.getByTestId("tl-card-c1")
    fireEvent.pointerDown(el, { clientX: 100, button: 0 })
    fireEvent.pointerMove(el, { clientX: 140 })       // +40px = +1s
    fireEvent.pointerUp(el, { clientX: 140 })
    expect(onRetime).toHaveBeenCalledWith("c1", 2, 4) // moved +1s
  })
  it("does not drag when not editable", () => {
    const onRetime = vi.fn()
    render(<TimelineCard cell={cell({})} pxPerSec={40} laneStartSec={0} variant="dialogue"
      selected editable={false} onSelect={() => {}} onRetime={onRetime} />)
    const el = screen.getByTestId("tl-card-c1")
    fireEvent.pointerDown(el, { clientX: 100, button: 0 })
    fireEvent.pointerMove(el, { clientX: 140 })
    fireEvent.pointerUp(el, { clientX: 140 })
    expect(onRetime).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `TimelineCard`.** Use local `useState` for an in-drag delta (px), apply it as inline `left`/`width` during drag (transform/opacity-only is preferred, but `left`/`width` from state is acceptable here since it is local and not animated via CSS transition). On `pointerdown` record `clientX` + mode (`move`/`resize-l`/`resize-r`) and `setPointerCapture`. On `pointermove` compute px delta. On `pointerup` convert delta→seconds (`pxToSec`), apply to start/end per mode, `clampRange(_, _, 0.2)`, call `onRetime(id, startSec, endSec)`, reset local delta. Guard all drag handlers on `editable`. Root element `data-testid={`tl-card-${cell.id}`}`. Apply the design-taste classes from the spec (neutral subtitle / accent dialogue, lead bar, grips-on-hover, mono timecodes, camera chip + speaker for dialogue).

- [ ] **Step 4: Run** → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/timeline/TimelineCard.tsx src/components/timeline/TimelineCard.test.tsx
git commit -m "feat(timeline): TimelineCard with drag-move + edge-resize retiming"
```

---

### Task 7: `TimelineRuler` + `TimelinePlayhead`

**Files:**
- Create: `src/components/timeline/TimelineRuler.tsx`, `src/components/timeline/TimelinePlayhead.tsx`
- Test: `src/components/timeline/TimelineRuler.test.tsx`

**Interfaces:**
- `TimelineRuler` props: `{ durationSec: number; pxPerSec: number; onScrub(sec: number): void }` — renders tick marks every "nice" interval (choose 1/2/5/10/30/60s so labels are ~≥60px apart), labels in `mono`, click → `onScrub(pxToSec(clickX, pxPerSec))`.
- `TimelinePlayhead` props: `{ currentSec: number; pxPerSec: number }` — a 1.5px line at `secToPx(currentSec)`, breathing handle (CSS keyframe).

- [ ] **Step 1: Failing test** — ruler renders a `0:00` label, and clicking at x=152 with `pxPerSec=38` calls `onScrub` with ~4.

```tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TimelineRuler } from "./TimelineRuler"

it("scrubs to clicked time", () => {
  const onScrub = vi.fn()
  render(<TimelineRuler durationSec={30} pxPerSec={38} onScrub={onScrub} />)
  const ruler = screen.getByTestId("tl-ruler")
  // jsdom getBoundingClientRect is 0-origin; offsetX≈clientX
  fireEvent.click(ruler, { clientX: 152 })
  expect(onScrub.mock.calls[0][0]).toBeCloseTo(4, 1)
  expect(screen.getByText("0:00")).toBeInTheDocument()
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** both components (tick interval picker is a pure helper `niceTickSec(pxPerSec)`; format `mm:ss` with a small `fmtSec` helper). **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/timeline/TimelineRuler.tsx src/components/timeline/TimelinePlayhead.tsx src/components/timeline/TimelineRuler.test.tsx
git commit -m "feat(timeline): ruler with scrub + breathing playhead"
```

---

### Task 8: `TimelineLane` — windowed card layout

**Files:**
- Create: `src/components/timeline/TimelineLane.tsx`
- Test: `src/components/timeline/TimelineLane.test.tsx`

**Interfaces:**
- Consumes: `TimelineCard` (Task 6), `isVisible` (Task 2).
- Props:
```ts
interface TimelineLaneProps {
  cells: CellData[]               // already lane-filtered + sorted (from deriveLanes)
  variant: "subtitle" | "dialogue"
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  selectedId: string | null
  editable: boolean
  onSelect(id: string): void
  onRetime(id: string, startSec: number, endSec: number): void
}
```
- Behaviour: renders only cells where `isVisible(startTime, endTime, viewStartSec, viewEndSec)`; passes through select/retime.

- [ ] **Step 1: Failing test** — a lane with 3 cells (at 0–2s, 100–102s, 4–6s), `view = [3, 8]`, renders only the 4–6s card (`tl-card` count === 1).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (filter by `isVisible`, map to `TimelineCard`). **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/timeline/TimelineLane.tsx src/components/timeline/TimelineLane.test.tsx
git commit -m "feat(timeline): windowed TimelineLane renders only visible cards"
```

---

### Task 9: Re-enable linked-URL video preview + master clock

**Files:**
- Modify: `src/components/ProjectWorkspace.tsx` (`videoSrc` from file `coreMediaUrl` instead of hardcoded `null`; "Link video" action calls `emitFileVideoSet`)
- Create: `src/components/timeline/useTimelineClock.ts`
- Test: `src/components/timeline/useTimelineClock.test.ts`

**Interfaces:**
- `useTimelineClock(): { currentSec, playing, setCurrentSec, play, pause, seekTo }` — local transport state; when a video player is present the player drives `setCurrentSec` via `onProgress` and `seekTo` calls the player ref; when absent, `currentSec` is a pure cursor moved by `seekTo`/ruler scrub.

- [ ] **Step 1:** Replace `const videoSrc: string | null = null` (`ProjectWorkspace.tsx:962`) with the active file's `coreMediaUrl` (read from the file record now carrying it — Task 4). Keep the `react-player` `VideoPlayer` mount but gate on `videoSrc` only (drop the `isSubtitleFile` coupling so any time-ordered file with a linked URL previews). Add a "Link video" toolbar action (prompt for URL → `emitFileVideoSet`).

- [ ] **Step 2: Failing test** for `useTimelineClock` — `seekTo(5)` sets `currentSec=5`; `play()`/`pause()` toggle `playing`.

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** the hook. **Step 5: Run** → PASS.

- [ ] **Step 6: Typecheck** `npx tsc -p tsconfig.app.json --noEmit`.

- [ ] **Step 7: Commit**

```bash
git add src/components/ProjectWorkspace.tsx src/components/timeline/useTimelineClock.ts src/components/timeline/useTimelineClock.test.ts
git commit -m "feat(timeline): linked-URL video preview as master clock"
```

---

### Task 10: `TimelineEditor` orchestrator

**Files:**
- Create: `src/components/timeline/TimelineEditor.tsx`
- Test: `src/components/timeline/TimelineEditor.test.tsx`

**Interfaces:**
- Consumes: `deriveLanes` (1), scale (2), `TimelineLane` (8), `TimelineRuler`/`TimelinePlayhead` (7), `useTimelineClock` (9), `EditorRow` (5), `CellWaveform`.
- Props:
```ts
interface TimelineEditorProps {
  cells: CellData[]
  coreMediaUrl: string | null
  editable: boolean
  onRetime(cellId: string, startSec: number, endSec: number): void
  /** Everything EditorRow needs for the selected-cell detail pane — pass the
   *  same props EditorTable already threads into EditorRow for one cell. */
  rowProps: Omit<EditorRowProps, "cell" | "rowIndex">
}
```
- Behaviour: `deriveLanes(cells)` → three lanes; zoom state (`pxPerSec`, persisted in `localStorage` key `codex:timelineZoom:<fileId>` via a small helper, default `ZOOM_DEFAULT`); horizontal scroll container → `viewStartSec`/`viewEndSec`; `useTimelineClock` for the playhead; `selectedId` state; renders the video preview (when `coreMediaUrl`), ruler, the Subtitle + Dialogue lanes, the Untimed tray (view/select-only), and the bottom detail pane (`<EditorRow cell={selectedCell} {...rowProps} />`). Zoom ± buttons clamp to `[ZOOM_MIN, ZOOM_MAX]`. Empty media → preserve the `TimelineAddMedia` empty state.

- [ ] **Step 1: Failing test** — given 1 subtitle + 1 dialogue + 1 untimed cell, renders one `tl-lane[data-variant=subtitle]`, one `[data-variant=dialogue]`, an untimed chip, and (after selecting the dialogue card) the detail pane shows its text. Zoom-in button increases rendered card width.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Typecheck** `npx tsc -p tsconfig.app.json --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add src/components/timeline/TimelineEditor.tsx src/components/timeline/TimelineEditor.test.tsx
git commit -m "feat(timeline): TimelineEditor orchestrator (lanes, ruler, preview, detail pane)"
```

---

### Task 11: Mount in the Media lens + wire optimistic clock-fenced retime

**Files:**
- Modify: `src/components/EditorTable.tsx` (render `TimelineEditor` when `isTimeOrdered && audioLens`)
- Modify: `src/components/ProjectWorkspace.tsx` and/or `src/hooks/useCells.ts` (retime handler: optimistic clock-fenced local update → `emitCellRetime` → outbox flush → `revalidateCells`)
- Test: `src/components/EditorTable.timeline.test.tsx`

**Interfaces:**
- Consumes: `TimelineEditor` (10), `emitCellRetime` (3), the `useCells` write-clock (FRO-247).
- Produces: `handleRetime(cellId, startSec, endSec)` wired into `TimelineEditor.onRetime`.

- [ ] **Step 1: Failing test** — render `EditorTable` for a time-ordered file in the Media lens (`audioLens` truthy); assert a `tl-track`/`TimelineEditor` root renders instead of the vertical virtual list; in the Text lens it still renders the vertical rows. (Mirror existing EditorTable test harness + mock `useCells`.)

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement the mount.** In `EditorTable.tsx`, where the vertical list renders for the media lens (the `displayCells`/virtualizer block, ~lines 1065–1200, and the empty-state at ~1179), branch: when `isTimeOrdered && audioLens`, render `<TimelineEditor cells={cellsWithAudio} coreMediaUrl={...} editable={canEdit} onRetime={onRetime} rowProps={...} />`; otherwise the existing list. Thread an `onRetime` prop down from `ProjectWorkspace` (alongside the existing `onAttachMediaFile`/`onAttachMediaUrl`).

- [ ] **Step 4: Implement `handleRetime`** in `ProjectWorkspace.tsx` (next to `handleAttachMediaUrl`, ~line 943): optimistically write the new seconds into the local cell via the same clock-fenced path used for edits (`writeSeqRef` + freshness floor — read `useCells` for the exact mechanism), then `await emitCellRetime({ projectId, fileId: activeFileId, cellId, startMs: Math.round(startSec*1000), endMs: Math.round(endSec*1000), author: currentUsername, getToken: getTokenForFile })`, then `flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })`, then `revalidateCells()`.

- [ ] **Step 5: Run** the timeline mount test → PASS. Run `npx vitest run src/components/EditorTable*.test.tsx` → no regressions.

- [ ] **Step 6: Typecheck + full unit run** `npx tsc -p tsconfig.app.json --noEmit && npx vitest run`.

- [ ] **Step 7: Commit**

```bash
git add src/components/EditorTable.tsx src/components/ProjectWorkspace.tsx src/hooks/useCells.ts src/components/EditorTable.timeline.test.tsx
git commit -m "feat(timeline): mount TimelineEditor in Media lens + clock-fenced cell.retime wiring"
```

---

### Task 12: Build verification + design polish (browser)

**Files:** none new (polish existing timeline components only).

- [ ] **Step 1: Vite build** `npx vite build` → succeeds, no type errors.

- [ ] **Step 2: Live verification** via the verify-dev-change / preview workflow: boot the dev stack, sign in as the seeded dev user, open a time-ordered subtitle file, switch to the **Media** lens.
  - Confirm the timeline renders Subtitle + Dialogue lanes with cards positioned by time, ruler + zoom, Untimed tray.
  - Drag a card and stretch an edge; reload; confirm the new timing **persisted** (projection round-trip).
  - Link a video URL; confirm the preview plays and the playhead tracks; scrub the ruler to seek.
  - Click cards; confirm the bottom detail pane (EditorRow) edits source/target/audio.
  - Capture a screenshot for the user.

- [ ] **Step 3: Design-taste pass.** Compare the live UI to the approved mockup (neutral Zinc + single steel-blue accent, Geist Mono timecodes, SVG icons, staggered reveal, hover grips, breathing playhead). Fix any drift. Verify read-only files disable drag, and dark mode (if applicable) keeps lane borders visible.

- [ ] **Step 4: Commit any polish**

```bash
git add -A
git commit -m "polish(timeline): design-taste pass + live-verified retime persistence"
```

---

## Self-Review

**Spec coverage:** §3 data model → Tasks 1, 4 (lanes + coreMediaUrl). §4 events → Tasks 3, 4. §5 master clock → Task 9. §6 components + EditorRow extraction → Tasks 5–8, 10. §6 mount → Task 11. §7 edge cases → Tasks 2 (clamp), 6 (editable guard), 8 (windowing), 11 (locks via existing path), 12 (read-only/dark). §8 testing → every task is TDD + Task 12 e2e. §10 decisions → encoded (retime both sides Task 3; Media-lens-is-timeline Task 11; two events Tasks 3–4; untimed view-only Tasks 8/10; EditorRow extract Task 5). No gaps.

**Placeholder scan:** Component tasks (6–11) intentionally reference "mirror the existing harness / read `emitCellAudioAttach`" because exact local helper names (outbox enqueue fn, EditorRow's full prop list, the FRO-247 write-clock API) must be read from the codebase at implementation time; every such pointer names the exact file/function to read, and all cross-task contracts (signatures, event types, payloads) are fully specified. No "TBD"/"add error handling"/"write tests for the above".

**Type consistency:** `deriveLanes` → `{ subtitle, dialogue, untimed }` used identically in Tasks 8/10. `onRetime(cellId, startSec, endSec)` in **seconds** is consistent across Tasks 6/8/10/11; ms conversion happens only in Task 11's `handleRetime` and Task 3's payload. `coreMediaUrl` consistent across Tasks 4/9/10. `pxPerSec` naming consistent across Tasks 2/6/7/8/10.
