/**
 * AQU-1146: `EditorTable` used to walk every display cell id on every
 * cell-store version bump (`sequentialNumberByCellId`, `paragraphGroupInfoByCellId`),
 * and `MemoizedRow` received the whole `completing`/`examples`/`errors`/
 * `previews` maps as props — a fresh map identity on any batch update broke
 * `React.memo` for every row, not just the touched one.
 *
 * This suite encodes the two regression guards from the issue's test
 * checklist:
 *  (a) a commit to one cell (or a map-identity change unrelated to a given
 *      row) does not re-render other rows — probed via the existing
 *      `window.__perfRowRenders` counters (see `isPerfLogEnabled`/`rowRenders`
 *      in EditorTable.tsx).
 *  (b) the paragraph-group and sequential line-number values stay CORRECT
 *      after an edit that inserts or removes a paragraph start (the new
 *      per-cell caches must not serve stale grouping/numbering).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, cleanup, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, Fragment, forwardRef, useImperativeHandle, type ComponentProps, type ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { setPerfLog } from "@/lib/perf-log"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

// happy-dom has no real layout engine, so the real LegendList may decide no
// rows are visible. Replace it with a trivial "render every row" stand-in,
// same pattern as the other EditorTable RTL suites.
vi.mock("@legendapp/list/react", () => ({
  LegendList: forwardRef(function MockLegendList({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: string[]
    renderItem: (props: { item: string; index: number }) => ReactNode
    keyExtractor?: (item: string, index: number) => string
  }, ref) {
    useImperativeHandle(ref, () => ({
      getState: () => ({ scroll: 0, positionAtIndex: (i: number) => i * 140, sizeAtIndex: () => 140 }),
      scrollToIndex: async () => undefined,
      scrollToOffset: async () => undefined,
    }))
    return createElement(
      "div",
      null,
      data.map((item, index) =>
        createElement(Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index })),
      ),
    )
  }),
}))

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

/** No `canonicalRef` (non-scripture doc) so `cellNumberLabel` falls through
 *  to the sequential `contentNumber`, not a verse label — the thing this
 *  suite is actually probing. */
function makeCellRows(
  id: string,
  index: number,
  opts: { paragraphStart?: boolean; targetValue?: string } = {},
): CellRow[] {
  return [
    {
      cellId: id, side: "source", value: `source ${index}`, valueHtml: null, type: "text",
      canonicalRef: null, anchorCellId: null, eventId: `${id}-source-${opts.targetValue ?? "0"}`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
      ...(opts.paragraphStart ? { metadata: { paragraphStart: true } } : {}),
    },
    {
      cellId: id, side: "target", value: opts.targetValue ?? `target ${index}`, valueHtml: null, type: "text",
      canonicalRef: null, anchorCellId: null, eventId: `${id}-target-${opts.targetValue ?? "0"}`,
      sourceEventId: `${id}-source-${opts.targetValue ?? "0"}`, lastEditor: "tester", lastEditAt: 2,
      validated: false, wordCount: 1,
    },
  ] satisfies CellRow[]
}

function makeStore(rows: CellRow[]): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

// Hoisted so re-renders (a fresh `tableProps()` call across a `rerender()`)
// pass the SAME function/map identity for anything the table forwards
// straight through to MemoizedRow without wrapping in its own useCallback —
// a fresh closure here would break React.memo for reasons that have nothing
// to do with the per-cell caching this suite is testing.
const noop = () => {}
const STABLE_EXAMPLES = new Map()
const STABLE_ERRORS = new Map<string, string>()
const STABLE_PREVIEWS = new Map<string, string>()
const STABLE_HEALTH_MAP = new Map()
// `infractions` defaults to `new Map()` and `rules` to `[]` inside
// EditorTable itself when the caller omits them — a fresh reference on every
// render, same trap as the maps above. Pass stable ones explicitly so this
// suite's render-count probe isn't confounded by that (pre-existing,
// out-of-scope-for-AQU-1146) prop.
const STABLE_INFRACTIONS = new Map()
const STABLE_RULES: never[] = []

function tableProps(store: CellStore, overrides: Partial<ComponentProps<typeof EditorTable>> = {}) {
  return {
    project,
    cellStore: store,
    username: "tester",
    isCompletionConfigured: true,
    isCompletionAvailable: true,
    completing: new Map<string, string>(),
    examples: STABLE_EXAMPLES,
    errors: STABLE_ERRORS,
    previews: STABLE_PREVIEWS,
    onCompleteSingle: noop,
    onCompleteBatch: noop,
    onCompleteParagraph: noop,
    healthMap: STABLE_HEALTH_MAP,
    infractions: STABLE_INFRACTIONS,
    rules: STABLE_RULES,
    lineNumbersEnabled: true,
    cellLabelsEnabled: false,
    sourceTextDirection: "ltr" as const,
    targetTextDirection: "ltr" as const,
    ...overrides,
  }
}

function renderTable(store: CellStore, overrides: Partial<ComponentProps<typeof EditorTable>> = {}) {
  const qc = new QueryClient()
  const result = render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(EditorActionsProvider, {
        value: {},
        children: createElement(EditorTable, tableProps(store, overrides)),
      }),
    ),
  )
  // Re-render with the SAME QueryClient instance — a fresh `new QueryClient()`
  // per call would itself change context identity and confound the render-
  // count probe this suite relies on.
  const rerenderWithProps = (nextOverrides: Partial<ComponentProps<typeof EditorTable>>) =>
    result.rerender(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(EditorActionsProvider, {
          value: {},
          children: createElement(EditorTable, tableProps(store, nextOverrides)),
        }),
      ),
    )
  return { ...result, rerenderWithProps }
}

function lineNumberFor(cellId: string): string | null {
  const row = document.querySelector(`[data-cell-id="${cellId}"]`)
  return row?.querySelector(".tabular-nums")?.textContent?.trim() ?? null
}

declare global {
  interface Window {
    __perfRowRenders?: Map<string, number>
    __perfResetRowRenders?: () => void
  }
}

beforeEach(() => setPerfLog(true))
afterEach(() => {
  cleanup()
  setPerfLog(false)
})

describe("EditorTable — incremental per-cell memos (AQU-1146)", () => {
  it("does not re-render other rows' MemoizedRow when only one cell's completing/examples/errors/previews entry changes", async () => {
    const store = makeStore([
      ...makeCellRows("cell-1", 0),
      ...makeCellRows("cell-2", 1),
      ...makeCellRows("cell-3", 2),
    ])
    const { rerenderWithProps } = renderTable(store, { completing: new Map() })
    await screen.findByText("target 0")

    window.__perfResetRowRenders?.()

    // Simulate a batch progress update that touches ONLY cell-2 — the parent
    // hands EditorTable a brand-new `completing` Map (its identity always
    // changes on a batch tick), but only cell-2's entry is new/different.
    rerenderWithProps({ completing: new Map([["cell-2", "generating"]]) })

    await screen.findByText("target 1")

    const renders = window.__perfRowRenders
    expect(renders).toBeDefined()
    // The touched row re-rendered...
    expect(renders?.get("cell-2") ?? 0).toBeGreaterThan(0)
    // ...but the untouched rows' MemoizedRow held its React.memo bail — this
    // is the whole point of AQU-1146: before the fix, the whole `completing`
    // map was forwarded as a MemoizedRow prop, so ITS identity change alone
    // re-rendered every row regardless of relevance.
    expect(renders?.get("cell-1") ?? 0).toBe(0)
    expect(renders?.get("cell-3") ?? 0).toBe(0)
  })

  it("keeps paragraph-group and sequential line-number values correct after an edit inserts a new paragraph-start cell", async () => {
    // Two SEPARATE single-cell "paragraphs" — each is its own paragraphStart
    // with nothing following it before the next start, so deriveParagraphs
    // opens a 1-cell group for each (too small for the rail button, which
    // requires size > 1). Inserting a non-start cell between them merges the
    // first one into a 2-cell group and shifts every later sequential number.
    const store = makeStore([
      ...makeCellRows("cell-1", 0, { paragraphStart: true }),
      ...makeCellRows("cell-2", 1, { paragraphStart: true }),
    ])
    renderTable(store)
    await screen.findByText("target 0")

    expect(lineNumberFor("cell-1")).toBe("1")
    expect(lineNumberFor("cell-2")).toBe("2")
    // Both groups are single-cell — no paragraph-draft button yet.
    expect(screen.queryByRole("button", { name: /Draft paragraph/ })).not.toBeInTheDocument()

    // Insert "cell-1b" between cell-1 and cell-2, as a NEW cell that is NOT a
    // paragraph start — this bumps listVersion (structural change), so
    // displayCellIds gets a new reference and every downstream cache must
    // recompute from scratch rather than serving stale per-cell entries.
    act(() => {
      store.replaceRows(
        [
          ...makeCellRows("cell-1", 0, { paragraphStart: true }),
          ...makeCellRows("cell-1b", 1),
          ...makeCellRows("cell-2", 2, { paragraphStart: true }),
        ],
        { full: true, maxServerSeq: 2 },
      )
    })

    await screen.findByText("target 1")

    // Sequential numbering recomputed for the new order, not stale.
    expect(lineNumberFor("cell-1")).toBe("1")
    expect(lineNumberFor("cell-1b")).toBe("2")
    expect(lineNumberFor("cell-2")).toBe("3")

    // Grouping recomputed too: cell-1 now starts a 2-cell group (itself +
    // cell-1b); cell-2 is still its own 1-cell group, so exactly one button.
    const buttons = await screen.findAllByRole("button", { name: /Draft paragraph \(\d+ cells\)/ })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName("Draft paragraph (2 cells)")
    expect(buttons[0].closest("[data-cell-id]")).toHaveAttribute("data-cell-id", "cell-1")
  })

  it("keeps paragraph-group and sequential numbering correct after an edit removes a paragraph start (groups split)", async () => {
    const store = makeStore([
      ...makeCellRows("cell-1", 0, { paragraphStart: true }),
      ...makeCellRows("cell-2", 1),
      ...makeCellRows("cell-3", 2, { paragraphStart: true }),
      ...makeCellRows("cell-4", 3),
    ])
    renderTable(store)
    await screen.findByText("target 0")

    // Two independent 2-cell groups (cell-1+cell-2, cell-3+cell-4) — both
    // render the same "(2 cells)" copy, so assert the count rather than a
    // single unique accessible name.
    expect(await screen.findAllByRole("button", { name: "Draft paragraph (2 cells)" })).toHaveLength(2)
    expect(lineNumberFor("cell-3")).toBe("3")

    // cell-3 loses its paragraphStart flag (source-side metadata edit): the
    // two 2-cell groups become one 4-cell group starting at cell-1, and only
    // ONE paragraph-draft button should remain.
    act(() => {
      store.replaceRows(
        [
          ...makeCellRows("cell-1", 0, { paragraphStart: true }),
          ...makeCellRows("cell-2", 1),
          ...makeCellRows("cell-3", 2, { paragraphStart: false }),
          ...makeCellRows("cell-4", 3),
        ],
        { full: true, maxServerSeq: 2 },
      )
    })

    await screen.findByText("target 0")

    const buttons = await screen.findAllByRole("button", { name: /Draft paragraph \(\d+ cells\)/ })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName("Draft paragraph (4 cells)")
    const row = buttons[0].closest("[data-cell-id]")
    expect(row).toHaveAttribute("data-cell-id", "cell-1")

    // Sequential numbering is unaffected by the paragraph-boundary change
    // (it's driven by cell type/import metadata, not paragraphStart).
    expect(lineNumberFor("cell-1")).toBe("1")
    expect(lineNumberFor("cell-2")).toBe("2")
    expect(lineNumberFor("cell-3")).toBe("3")
    expect(lineNumberFor("cell-4")).toBe("4")
  })
})
