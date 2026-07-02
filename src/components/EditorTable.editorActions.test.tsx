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
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider, type EditorActionsContextValue } from "@/context/EditorActionsContext"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

// happy-dom has no real layout engine, so the scroll container the real
// @tanstack/react-virtual measures against always reports a 0px height and
// the virtualizer renders zero rows. Replace it with a trivial "render every
// row" stand-in — good enough for a single-cell wiring test and avoids
// depending on layout measurement this environment can't provide.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => {
    const size = opts.estimateSize()
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      start: index * size,
      end: (index + 1) * size,
      size,
      key: index,
    }))
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * size,
      measureElement: () => {},
      scrollToIndex: () => {},
      scrollOffset: 0,
      getVirtualItemForOffset: () => items[0],
    }
  },
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
