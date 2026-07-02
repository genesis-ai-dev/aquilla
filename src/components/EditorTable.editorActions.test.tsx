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
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

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
      data: CellData[]
      renderItem: (props: { item: CellData; index: number }) => ReactNode
      keyExtractor?: (item: CellData, index: number) => string
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
            { key: keyExtractor?.(item, index) ?? item.id },
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

function makeCell(id: string): CellData {
  return {
    id,
    fileId: "file-1",
    original: "hello",
    translated: "bonjour",
    context: "GEN 1:1",
    group: "GEN 1",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }
}

function renderTable(actions: Partial<EditorActionsContextValue>) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={actions}>
        <EditorTable
          project={project}
          cells={[makeCell("cell-1")]}
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
})
