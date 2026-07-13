/**
 * FRO perf cleanup: onInfractionClick/onOpenComments/onOpenHistory/
 * onAiSetupNeeded/onOpenRecording moved from EditorTable's prop bag into
 * EditorActionsContext (pure pass-through openers, never consumed between
 * EditorTable and the row). This test wires the real EditorTable through the
 * real provider and clicks a real row affordance to prove the context
 * actually reaches EditorRow — a prop-plumbing mistake here would silently
 * disable the "Add comment" button (it only renders when onOpenComments is
 * truthy) rather than throwing a type error.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider, type EditorActionsContextValue } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/hooks/useMicPermission", () => ({
  useMicPermission: () => ({ micDenied: true }),
}))

// happy-dom has no real layout engine, so the real LegendList may decide no
// rows are visible. Replace it with a trivial "render every row" stand-in —
// good enough for a single-cell wiring test and independent of layout.
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

function makeRows(id: string): CellRow[] {
  return [
    {
      cellId: id,
      side: "source",
      value: "hello",
      valueHtml: null,
      type: "text",
      canonicalRef: "GEN 1:1",
      anchorCellId: null,
      eventId: `${id}-source`,
      sourceEventId: null,
      lastEditor: null,
      lastEditAt: 1,
      validated: false,
      wordCount: 1,
    },
    {
      cellId: id,
      side: "target",
      value: "bonjour",
      valueHtml: null,
      type: "text",
      canonicalRef: "GEN 1:1",
      anchorCellId: null,
      eventId: `${id}-target`,
      sourceEventId: `${id}-source`,
      lastEditor: "tester",
      lastEditAt: 2,
      validated: false,
      wordCount: 1,
    },
  ]
}

function makeStore(cellId: string): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cellId), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(actions: Partial<EditorActionsContextValue>) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={actions}>
        <EditorTable
          project={project}
          cellStore={makeStore("cell-1")}
          username="tester"
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
          cellLabelsEnabled={false}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

describe("EditorTable — EditorActionsContext wiring", () => {
  it("clicking the row's comment affordance calls the context's onOpenComments with the cell id", async () => {
    const onOpenComments = vi.fn()
    renderTable({ onOpenComments })

    const button = await screen.findByRole("button", { name: "Add comment" })
    fireEvent.click(button)

    expect(onOpenComments).toHaveBeenCalledTimes(1)
    expect(onOpenComments).toHaveBeenCalledWith("cell-1")
  })

  it("does not render the comment affordance when onOpenComments is absent from context", async () => {
    renderTable({})

    // A moment for the row to mount before asserting absence.
    await screen.findByText("bonjour")
    expect(screen.queryByRole("button", { name: "Add comment" })).not.toBeInTheDocument()
  })

  it("raises and unclamps the row while microphone-permission help is open", async () => {
    renderTable({ onOpenRecording: vi.fn() })

    const micButton = await screen.findByRole("button", {
      name: "Microphone access blocked — click for help",
    })
    fireEvent.click(micButton)

    expect(screen.getByRole("tooltip", { name: /microphone blocked/i })).toBeInTheDocument()
    expect(micButton.closest("[data-grid-row]")).toHaveClass("z-30", "overflow-visible")
  })
})
