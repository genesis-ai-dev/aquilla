/**
 * The source and target columns' first text lines must sit on the same baseline.
 *
 * That alignment is not produced by a shared grid row — each column stacks its
 * own header strip above its text, and they line up only because both strips
 * reserve the same 20px (h-4 + mb-1):
 *
 *   source column:  py-1.5 (6px) + context line (20px)          -> text at 26px
 *   target column:  header lane (20px) + surface py-1.5 (6px)   -> text at 26px
 *
 * So the context line must render even when it has nothing to say. `cell.context`
 * is a VTT cue range (see buildCellData in useCells.ts) and is therefore EMPTY for
 * every ordinary text cell — gating the line on truthy content drops it for the
 * common case and rides all that source text 20px above its translation. The
 * target lane can't be gated to match, because it also reserves the strip the
 * floating action rail occupies.
 *
 * happy-dom has no layout engine, so this asserts the structural invariant that
 * produces the alignment rather than measured geometry.
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

/** No startMs/endMs, so buildCellData derives an empty `context` — the common case. */
function makeRows(id: string): CellRow[] {
  return [
    {
      cellId: id, side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: id, side: "target", value: "bonjour", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-target`,
      sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
    },
  ]
}

function renderTable({ lineNumbers = false }: { lineNumbers?: boolean } = {}) {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows("cell-1"), { full: true, maxServerSeq: 1 })
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={store}
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
          lineNumbersEnabled={lineNumbers}
          cellLabelsEnabled={false}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

describe("EditorTable — source/target first-line alignment", () => {
  it("reserves the source context line even when the cell has no context", async () => {
    renderTable()
    await screen.findByText("hello")

    const contextLine = screen.getByTestId("source-context-line")
    // Present, and empty — this is the case that regresses if it gets gated.
    expect(contextLine.textContent).toBe("")
    expect(contextLine.className).toContain("h-4")
    expect(contextLine.className).toContain("mb-1")
  })

  it("mirrors that strip with the target header lane, so both reserve the same height", async () => {
    renderTable()
    await screen.findByText("hello")

    const contextLine = screen.getByTestId("source-context-line")
    const headerLane = screen.getByTestId("target-header-lane")

    // The mirror IS the alignment: same reserved height on both sides.
    for (const cls of ["h-4", "mb-1"]) {
      expect(contextLine.className).toContain(cls)
      expect(headerLane.className).toContain(cls)
    }
  })

  it("reserves the same strip in the gutter, so the line number rides the first source line", async () => {
    renderTable()
    await screen.findByText("hello")

    // Third mirror. The gutter is a separate grid column, so it needs its own
    // copy of the strip or the number floats above the text it labels.
    const spacer = screen.getByTestId("gutter-strip-spacer")
    expect(spacer.className).toContain("h-4")
    expect(spacer.className).toContain("mb-1")

    // Combined select/badges/number gutter owns the vertical padding; the
    // spacer sits inside the number slot (select | badges+number group).
    const gutter = spacer.parentElement?.parentElement?.parentElement
    expect(gutter?.className).toContain("py-1.5")
  })

  it("sizes the line-number box to the source line height, not a fixed height", async () => {
    renderTable({ lineNumbers: true })
    await screen.findByText("hello")

    // Centering the digit in a fontSize x 1.6 box is what keeps it on the first
    // line at every reader font size; a fixed height only agrees at one size.
    const numberBox = screen.getByLabelText("Line 1")
    expect(numberBox.style.height).toBe("calc(14px * 1.6)")
    expect(numberBox.className).not.toContain("h-6")
  })
})
