/**
 * AQU-687: the target editor must keep a stable width whether or not a
 * prediction/validation affordance is present.
 *
 * Regression: the validation control used to
 * render `null` for a cell with no content, so the editor's `flex-1` column
 * reclaimed the button's slot + gap — and then snapped narrower the instant a
 * prediction/draft filled the cell (`hasContent` flips true → the 24px button
 * appears). The fix reserves a fixed `w-6` gutter at all times.
 *
 * happy-dom has no layout engine, so this asserts the structural invariant that
 * causes the jump: the fixed-width gutter slot is present with the SAME width
 * class for both an empty and a translated cell.
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

function makeRows(id: string, targetValue: string): CellRow[] {
  return [
    {
      cellId: id, side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: id, side: "target", value: targetValue, valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-target`,
      sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
    },
  ]
}

function makeStore(cellId: string, targetValue: string): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows(cellId, targetValue), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(targetValue: string) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={makeStore("cell-1", targetValue)}
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

describe("EditorTable — AQU-687 stable target width", () => {
  it("reserves the fixed-width validation gutter for a cell WITH content", async () => {
    renderTable("bonjour")
    await screen.findByText("hello")
    const gutter = screen.getByTestId("validation-gutter")
    // Fixed-width slot present, and the validate affordance lives inside it.
    expect(gutter.className).toContain("w-6")
    expect(gutter.querySelector("button")).not.toBeNull()
    const automaticRibbon = screen.getByTestId("health-ribbon")
    expect(automaticRibbon.dataset.healthStage).toBe("automatic")
    expect(Number(automaticRibbon.dataset.healthOpacity)).toBeLessThan(0.5)
    expect(document.querySelector('[data-editor-cell-surface="source"]')).not.toBeNull()
    expect(document.querySelector('[data-editor-cell-surface="target-column"]')).not.toBeNull()
    expect(document.querySelector('[data-editor-cell-surface="target"]')).not.toBeNull()
    expect(document.querySelector('[data-editor-cell-surface="target-read"]')).not.toBeNull()
  })

  it("STILL reserves the same fixed-width gutter for an EMPTY cell (no width jump)", async () => {
    renderTable("")
    await screen.findByText("hello")
    const gutter = screen.getByTestId("validation-gutter")
    // The slot is present with the identical width class even though there is
    // no validation button to show — this is what holds the editor width steady
    // when a prediction later fills the cell.
    expect(gutter.className).toContain("w-6")
    expect(gutter.querySelector("button")).toBeNull()
    const untranslatedRibbon = screen.getByTestId("health-ribbon")
    expect(untranslatedRibbon.dataset.healthStage).toBe("untranslated")
    expect(Number(untranslatedRibbon.dataset.healthOpacity)).toBeLessThan(0.5)
  })
})
