/**
 * p1-paragraph-ui-wiring (Task 3): the "Draft paragraph" rail button wires
 * the pre-existing `completeParagraph` hook function so a translator can
 * draft a whole paragraph as one unit, instead of cell-by-cell.
 *
 * Encodes intent (not just markup): the button must appear ONLY on a
 * `paragraphStart` cell whose group has more than one cell, must route
 * through a confirm dialog before firing, and must be completely absent
 * (not just disabled) for legacy/prop-less callers that never pass
 * `onCompleteParagraph` — so old call sites keep compiling and rendering
 * unchanged.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

// happy-dom has no real layout engine, so the real LegendList may decide no
// rows are visible. Replace it with a trivial "render every row" stand-in,
// following EditorTable.editorActions.test.tsx's pattern.
vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")

  return {
    LegendList: React.forwardRef(function MockLegendList({
      data,
      renderItem,
      keyExtractor,
    }: {
      data: string[]
      renderItem: (props: { item: string; index: number }) => ReactNode
      keyExtractor?: (item: string, index: number) => string
    }, ref) {
      React.useImperativeHandle(ref, () => ({
        getState: () => ({
          scroll: 0,
          positionAtIndex: (index: number) => index * 140,
          sizeAtIndex: () => 140,
        }),
        scrollToIndex: async () => undefined,
        scrollToOffset: async () => undefined,
      }))

      return React.createElement(
        "div",
        null,
        data.map((item, index) => (
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? item },
            renderItem({ item, index }),
          )
        )),
      )
    }),
  }
})

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

// Three cells, one paragraph (only the first carries paragraphStart) — a
// multi-cell group so the rail button is eligible to render. `validatedIds`
// marks specific cells' TARGET as already validated (coordinator follow-up:
// mixed-validation fixtures).
function makeRows(
  cellIds: string[],
  paragraphStartIds: ReadonlySet<string>,
  validatedIds: ReadonlySet<string> = new Set(),
): CellRow[] {
  return cellIds.flatMap((id, i) => [
    {
      cellId: id,
      side: "source",
      value: `source ${i}`,
      valueHtml: null,
      type: "text",
      canonicalRef: `GEN 1:${i + 1}`,
      anchorCellId: null,
      eventId: `${id}-source`,
      sourceEventId: null,
      lastEditor: null,
      lastEditAt: 1,
      validated: false,
      wordCount: 1,
      ...(paragraphStartIds.has(id) ? { metadata: { paragraphStart: true } } : {}),
    },
    {
      cellId: id,
      side: "target",
      value: `target ${i}`,
      valueHtml: null,
      type: "text",
      canonicalRef: `GEN 1:${i + 1}`,
      anchorCellId: null,
      eventId: `${id}-target`,
      sourceEventId: `${id}-source`,
      lastEditor: "tester",
      lastEditAt: 2,
      validated: validatedIds.has(id),
      wordCount: 1,
    },
  ] satisfies CellRow[])
}

function makeStore(
  cellIds: string[],
  paragraphStartIds: ReadonlySet<string>,
  validatedIds: ReadonlySet<string> = new Set(),
): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cellIds, paragraphStartIds, validatedIds), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(
  cellStore: CellStore,
  onCompleteParagraph?: (cellId: string) => void,
  completing: Map<string, string> = new Map(),
) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={cellStore}
          username="tester"
          isCompletionConfigured={true}
          isCompletionAvailable={true}
          completing={completing}
          examples={new Map()}
          errors={new Map()}
          previews={new Map()}
          onCompleteSingle={() => {}}
          onCompleteBatch={() => {}}
          onCompleteParagraph={onCompleteParagraph}
          healthMap={new Map()}
          lineNumbersEnabled={false}
          cellLabelsEnabled={false}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

describe("EditorTable — Draft paragraph rail button (p1-paragraph-ui-wiring)", () => {
  it("renders on the paragraph-start cell of a multi-cell group, and firing it (through the confirm dialog) calls onCompleteParagraph with that cell id", async () => {
    const onCompleteParagraph = vi.fn()
    const store = makeStore(["cell-1", "cell-2", "cell-3"], new Set(["cell-1"]))
    renderTable(store, onCompleteParagraph)

    const button = await screen.findByRole("button", { name: "Draft paragraph (3 cells)" })
    fireEvent.click(button)

    // Confirm dialog gates the action — nothing fires yet.
    expect(onCompleteParagraph).not.toHaveBeenCalled()
    const confirm = await screen.findByRole("button", { name: "Draft paragraph" })
    fireEvent.click(confirm)

    expect(onCompleteParagraph).toHaveBeenCalledTimes(1)
    expect(onCompleteParagraph).toHaveBeenCalledWith("cell-1")
  })

  it("does not render the button on non-start cells of the same group", async () => {
    const onCompleteParagraph = vi.fn()
    const store = makeStore(["cell-1", "cell-2", "cell-3"], new Set(["cell-1"]))
    renderTable(store, onCompleteParagraph)

    await screen.findByText("target 0")

    // Only one paragraph-draft button in the whole table (on cell-1).
    const buttons = screen.getAllByRole("button", { name: /Draft paragraph \(\d+ cells\)/ })
    expect(buttons).toHaveLength(1)
    const row = buttons[0].closest("[data-cell-id]")
    expect(row).toHaveAttribute("data-cell-id", "cell-1")
  })

  it("does not render the button when onCompleteParagraph is absent (legacy/prop-less callers)", async () => {
    const store = makeStore(["cell-1", "cell-2", "cell-3"], new Set(["cell-1"]))
    renderTable(store, undefined)

    await screen.findByText("target 0")

    expect(screen.queryByRole("button", { name: /Draft paragraph/ })).not.toBeInTheDocument()
  })

  it("does not render the button when the paragraph group has only one cell", async () => {
    const onCompleteParagraph = vi.fn()
    // Single-file, single-cell "paragraph": deriveParagraphs still opens a
    // group at the first cell, but its length is 1 — the Sparkles button
    // already covers this case.
    const store = makeStore(["cell-1"], new Set(["cell-1"]))
    renderTable(store, onCompleteParagraph)

    await screen.findByText("target 0")

    expect(screen.queryByRole("button", { name: /Draft paragraph/ })).not.toBeInTheDocument()
  })

  // Coordinator follow-up: dialog copy must never claim a count that
  // doesn't match what will actually be drafted once validated cells are
  // excluded (completeParagraph's skip-validated-cells guard).
  it("shows truthful \"N of M\" copy in the confirm dialog when one cell in the group is already validated", async () => {
    const onCompleteParagraph = vi.fn()
    const store = makeStore(["cell-1", "cell-2", "cell-3"], new Set(["cell-1"]), new Set(["cell-2"]))
    renderTable(store, onCompleteParagraph)

    const button = await screen.findByRole("button", { name: "Draft paragraph (3 cells)" })
    fireEvent.click(button)

    expect(await screen.findByText(
      "Draft this paragraph? 2 of 3 cells will be drafted; already-validated cells are kept as-is.",
    )).toBeInTheDocument()
  })

  it("hides the button entirely when every cell in the group is already validated (nothing left to draft)", async () => {
    const onCompleteParagraph = vi.fn()
    const store = makeStore(
      ["cell-1", "cell-2", "cell-3"],
      new Set(["cell-1"]),
      new Set(["cell-1", "cell-2", "cell-3"]),
    )
    renderTable(store, onCompleteParagraph)

    await screen.findByText("target 0")

    expect(screen.queryByRole("button", { name: /Draft paragraph/ })).not.toBeInTheDocument()
  })

  // Coordinator follow-up: a validated start cell never gets its own
  // `completing` entry (it's excluded from the drafting set), so the button
  // must derive its busy state from the WHOLE group, not just its own row.
  it("disables the button while a sibling cell in the same group is completing, even though the start cell's own completing entry is absent", async () => {
    const onCompleteParagraph = vi.fn()
    const store = makeStore(["cell-1", "cell-2", "cell-3"], new Set(["cell-1"]))
    // cell-2 (a non-start sibling) is mid-draft; cell-1 (the start/button row)
    // has no completing entry of its own. Both cell-2's Sparkles button AND
    // cell-1's paragraph-draft button surface a "Generating…" tooltip while
    // ANY completion is in flight, so disambiguate by the row (cell-1 is the
    // only row that can host the paragraph-draft button at all).
    renderTable(store, onCompleteParagraph, new Map([["cell-2", "generating"]]))

    await screen.findByText("target 0")
    const row = document.querySelector('[data-cell-id="cell-1"]')
    expect(row).not.toBeNull()
    const buttons = row!.querySelectorAll('button[aria-label="Generating…"]')
    // Exactly one — the paragraph-draft button (cell-1 itself has no own
    // completing entry, so its Sparkles button is NOT in a "Generating…" state).
    expect(buttons).toHaveLength(1)
    const button = buttons[0] as HTMLButtonElement
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onCompleteParagraph).not.toHaveBeenCalled()
  })
})
