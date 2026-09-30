/**
 * AQU-1163: a cell another user holds the focus lease on must stay a Tab stop.
 *
 * The target read surface used to drop its `tabIndex` whenever `lockHolderLabel`
 * was set. That removed the row's cell-sized Tab stop, so Tab from the focused
 * grid-row wrapper skipped straight past the cell into the row's floating action
 * rail — the user who already could not click into the cell then found Tab
 * cycling that row's buttons instead of walking on to the next cell. It was also
 * silent: nothing said why the cell would not take text.
 *
 * A read-only textbox is focusable (only a *disabled* control is not), so the
 * guard here is that a locked cell keeps `tabIndex=0`, still precedes the action
 * rail in the row's tab order, and carries the lock reason on both its tooltip
 * and its accessible name.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

// happy-dom has no real layout engine, so LegendList may decide no rows are
// visible. Replace it with a trivial "render every row" stand-in.
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
        getState: () => ({ scroll: 0, positionAtIndex: (i: number) => i * 140, sizeAtIndex: () => 140 }),
        scrollToIndex: async () => undefined,
        scrollToOffset: async () => undefined,
      }))
      return React.createElement(
        "div",
        null,
        data.map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? item },
            renderItem({ item, index }),
          ),
        ),
      )
    }),
  }
})

afterEach(cleanup)

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

const TARGET_TEXT = "bonjour"

function makeStore(): CellStore {
  const rows: CellRow[] = [
    {
      cellId: "cell-1", side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-source",
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: "cell-1", side: "target", value: TARGET_TEXT, valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-target-1",
      sourceEventId: "cell-1-source", lastEditor: "alice", lastEditAt: 2, validated: false,
      wordCount: 1,
    },
  ]
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

async function renderTable(cellLockHolders?: ReadonlyMap<string, string>) {
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={makeStore()}
          username="tester"
          cellLockHolders={cellLockHolders}
          isCompletionConfigured={false}
          isCompletionAvailable={false}
          completing={new Map()}
          examples={new Map()}
          errors={new Map()}
          previews={new Map()}
          onCompleteSingle={() => {}}
          onCompleteBatch={() => {}}
          healthMap={new Map()}
          lineNumbersEnabled={false}
          cellLabelsEnabled
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
  await screen.findByText(TARGET_TEXT)
  const surface = document.querySelector<HTMLElement>("[data-target-read-view]")
  expect(surface).toBeTruthy()
  return surface as HTMLElement
}

describe("EditorTable — AQU-1163 a lease-locked cell stays a Tab stop", () => {
  it("keeps tabIndex=0 on the target read surface while a peer holds the lease", async () => {
    const surface = await renderTable(new Map([["cell-1", "Alice"]]))
    // The regression: this was `undefined`, so Tab skipped the cell entirely.
    expect(surface.getAttribute("tabindex")).toBe("0")
    // Still read-only — focusable is not the same as editable.
    expect(surface.getAttribute("aria-readonly")).toBe("true")
  })

  it("explains why the locked cell will not take text, on hover and to a screen reader", async () => {
    const surface = await renderTable(new Map([["cell-1", "Alice"]]))
    expect(surface.getAttribute("data-target-locked-by")).toBe("Alice")
    expect(surface.getAttribute("title")).toContain("Alice")
    // The reason rides the accessible name too, so it is announced on focus
    // rather than only shown to a mouse user.
    expect(surface.getAttribute("aria-label")).toContain("Alice")
  })

  it("puts the locked cell before the row's action rail in the tab order", async () => {
    const surface = await renderTable(new Map([["cell-1", "Alice"]]))
    const row = surface.closest("[data-grid-row]")
    expect(row).toBeTruthy()
    const rail = row?.querySelector("[data-slot='cell-action-rail']")
    expect(rail).toBeTruthy()
    // Tab walks the row in document order: reaching the cell before the rail is
    // what stops a locked row from dumping the user straight into its buttons.
    expect(
      surface.compareDocumentPosition(rail as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("leaves an unlocked cell editable with no lock affordance", async () => {
    const surface = await renderTable()
    expect(surface.getAttribute("tabindex")).toBe("0")
    expect(surface.getAttribute("title")).toBeNull()
    expect(surface.getAttribute("data-target-locked-by")).toBeNull()
    expect(surface.getAttribute("aria-readonly")).toBeNull()
  })
})
