/**
 * AQU-2260 third pass (Oct 29): three row explanations that used to be hover
 * text. Hover may only NAME an icon-only button, so:
 *  - a re-import highlight explains itself from an (i) on click,
 *  - a cell another person is editing says so when you click it (the click
 *    that would have opened the editor),
 *  - the selection square has no "drag to select" hover hint at all.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { TooltipProvider } from "@/components/ui/tooltip"
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

function makeStore(sourceMetadata?: Record<string, unknown>): CellStore {
  const rows: CellRow[] = [
    {
      cellId: "cell-1", side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-source",
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
      metadata: sourceMetadata ?? null,
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

async function renderTable({
  cellLockHolders,
  sourceMetadata,
  activeLaneId = null,
}: {
  cellLockHolders?: ReadonlyMap<string, string>
  sourceMetadata?: Record<string, unknown>
  activeLaneId?: string | null
} = {}) {
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider delay={0}>
        <EditorActionsProvider value={{}}>
          <EditorTable
            project={project}
            cellStore={makeStore(sourceMetadata)}
            username="tester"
            activeLaneId={activeLaneId}
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
      </TooltipProvider>
    </QueryClientProvider>,
  )
  await screen.findByText(TARGET_TEXT)
}

const REIMPORT_NOTE = "The source text changed in a re-import. The translation was kept. Validating this cell clears the highlight."

describe("EditorTable row notes open on click (AQU-2260 third pass)", () => {
  it("explains a re-import highlight from an (i) on click, with no hover title on the row", async () => {
    await renderTable({
      sourceMetadata: { aquillaImport: { reviewLanes: ["lane-fr"] } },
      activeLaneId: "lane-fr",
    })
    const row = document.querySelector<HTMLElement>("[data-source-review='true']")
    expect(row).toBeTruthy()
    expect(row?.getAttribute("title")).toBeNull()
    expect(screen.queryByText(REIMPORT_NOTE)).not.toBeInTheDocument()

    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Why this line is highlighted" }))
    expect(await screen.findByTestId("source-review-info-note")).toHaveTextContent(REIMPORT_NOTE)
  })

  it("shows no re-import (i) on a row that does not need review", async () => {
    await renderTable({ activeLaneId: "lane-fr" })
    expect(screen.queryByRole("button", { name: "Why this line is highlighted" })).not.toBeInTheDocument()
  })

  it("says who is editing a locked cell when you click it, and closes on a second click", async () => {
    await renderTable({ cellLockHolders: new Map([["cell-1", "Alice"]]) })
    const surface = document.querySelector<HTMLElement>("[data-target-read-view]") as HTMLElement
    expect(surface.getAttribute("title")).toBeNull()
    expect(screen.queryByTestId("target-lock-note")).not.toBeInTheDocument()

    fireEvent.click(surface)
    expect(await screen.findByTestId("target-lock-note")).toHaveTextContent("Locked — Alice is editing this cell")

    fireEvent.click(surface)
    await vi.waitFor(() => expect(screen.queryByTestId("target-lock-note")).not.toBeInTheDocument())
  })

  it("opens no lock note on a cell nobody else is editing", async () => {
    await renderTable()
    const surface = document.querySelector<HTMLElement>("[data-target-read-view]") as HTMLElement
    fireEvent.click(surface)
    expect(screen.queryByTestId("target-lock-note")).not.toBeInTheDocument()
  })

  it("gives the selection square no drag-to-select hover hint", async () => {
    await renderTable()
    const square = screen.getByRole("checkbox", { name: /Select cell/ })
    expect(square.closest("[data-slot='tooltip-trigger']")).toBeNull()
    fireEvent.pointerEnter(square)
    fireEvent.mouseEnter(square)
    fireEvent.focus(square)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText(/Drag up or down/)).not.toBeInTheDocument()
  })
})
