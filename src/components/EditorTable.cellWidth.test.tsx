/**
 * AQU-1101 — the source and target columns must stay equal in width no matter
 * what is inside them.
 *
 * The regression: the row template used bare `1fr` tracks. A bare `1fr` carries
 * an implicit `min-width: auto`, so a single unbreakable token (a long URL, a
 * 300-character run of letters) sized ITS track to min-content and took the
 * width out of the sibling — the row's source and target cells stopped lining
 * up with each other and with the header row, and the row could overflow
 * sideways.
 *
 * The fix is structural, in two halves, and BOTH are needed:
 *   1. `minmax(0,1fr)` floors the TRACK, so content can't grow it.
 *   2. `min-w-0` + `break-words` on the cell surfaces, because a grid/flex item
 *      keeps its own `min-width: auto` and would otherwise just overflow the
 *      column it can no longer widen.
 *
 * happy-dom has no layout engine, so — like the sibling column-alignment
 * suite — this asserts the structural invariant that produces the equal widths
 * rather than measured geometry.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { TranslatedEditor } from "./TranslatedEditor"
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

/** The exact shape that blew the column out: no whitespace anywhere in it. */
const UNBREAKABLE = "a".repeat(300)
const LONG_URL = `https://example.com/${"segment-".repeat(30)}end`

function makeRows(id: string, sourceText: string, targetText: string): CellRow[] {
  return [
    {
      cellId: id, side: "source", value: sourceText, valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: id, side: "target", value: targetText, valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-target`,
      sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
    },
  ]
}

const projectWithCast: ProjectRecord = {
  ...project,
  ttsSettings: {
    castAssignments: { "cell-1": "voice-ravi" },
    voices: [{ id: "voice-ravi", name: "Ravi" }],
  },
} as unknown as ProjectRecord

function renderTable({
  sourceText = "hello",
  targetText = "bonjour",
}: { sourceText?: string; targetText?: string } = {}) {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows("cell-1", sourceText, targetText), { full: true, maxServerSeq: 1 })
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={projectWithCast}
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
          lineNumbersEnabled={false}
          cellLabelsEnabled={false}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

/** Every grid that has to agree on the row template: the header row, the
 *  paragraph bar, and each body row all read from the same `gridCols`. */
function gridClassNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[class*='grid-cols-']"))
    .map((el) => el.className)
    .filter((cn) => cn.includes("grid-cols-["))
}

describe("EditorTable — source/target columns stay equal in width", () => {
  it("floors both text tracks at zero so content can never widen one", async () => {
    const { container } = renderTable({ targetText: UNBREAKABLE })
    await screen.findByText("hello")

    const grids = gridClassNames(container)
    expect(grids.length).toBeGreaterThan(0)
    for (const className of grids) {
      // Two `minmax(0,1fr)` tracks — equal fractions of whatever is left after
      // the fixed gutter, regardless of what the cells hold.
      expect(className).toContain("minmax(0,1fr)_minmax(0,1fr)")
      // A bare `1fr` track is the bug. Its implicit `min-width: auto` is what
      // let the unbreakable token size the track to min-content.
      expect(className).not.toMatch(/grid-cols-\[\d+px_1fr_1fr\]/)
    }
  })

  it("lets the source cell shrink to its track and breaks the token inside it", async () => {
    const { container } = renderTable({ sourceText: UNBREAKABLE })
    await screen.findByText(UNBREAKABLE)

    const source = container.querySelector<HTMLElement>('[data-editor-cell-surface="source"]')!
    // min-w-0: a grid item's own `min-width: auto` would still overflow the
    // column it can no longer widen.
    expect(source.className).toContain("min-w-0")
    // break-words is inherited by the source text renderers below it, so the
    // token wraps instead of running past the cell edge.
    expect(source.className).toContain("break-words")
  })

  it("does the same on the target side, at rest", async () => {
    const { container } = renderTable({ targetText: LONG_URL })
    await screen.findByText(LONG_URL)

    const column = container.querySelector<HTMLElement>('[data-editor-cell-surface="target-column"]')!
    const well = container.querySelector<HTMLElement>('[data-editor-cell-surface="target"]')!
    const read = container.querySelector<HTMLElement>('[data-editor-cell-surface="target-read"]')!

    // The column is the grid item; the well and read surface are flex children
    // that would each re-assert a content-based minimum on the way down.
    expect(column.className).toContain("min-w-0")
    expect(well.className).toContain("min-w-0")
    expect(read.className).toContain("min-w-0")

    // The read surface is `whitespace-pre-wrap`, which on its own PRESERVES an
    // unbreakable run intact — break-words is what actually breaks it.
    expect(read.className).toContain("whitespace-pre-wrap")
    expect(read.className).toContain("break-words")
  })

  it("keeps normal prose wrapping at word boundaries", async () => {
    const { container } = renderTable()
    await screen.findByText("hello")

    const read = container.querySelector<HTMLElement>('[data-editor-cell-surface="target-read"]')!
    // `break-words` (overflow-wrap: break-word) only breaks a word that cannot
    // fit on a line of its own — ordinary text is untouched. The bug's other
    // candidate fix, `break-all`, would hyphenlessly chop normal prose mid-word,
    // so its absence is part of the contract.
    expect(read.className).not.toContain("break-all")
  })
})

// The read surface and the editing surface are two different DOM nodes, and the
// row must not jump when the cell swaps one for the other. If only the read
// surface wrapped, clicking into a cell holding a long token would re-widen its
// track for as long as the editor was mounted.
describe("TranslatedEditor — the active cell wraps the same way the read surface does", () => {
  it("breaks an unbreakable token on the editable surface (full height)", () => {
    render(
      <TranslatedEditor
        cellId="cell-wrap-1"
        initialPlain={UNBREAKABLE}
        initialHtml={`<p>${UNBREAKABLE}</p>`}
        onCommit={() => {}}
      />,
    )
    const surface = document.querySelector(".ProseMirror") as HTMLElement
    expect(surface).toBeTruthy()
    expect(surface.className).toContain("break-words")
    expect(surface.className).toContain("min-w-0")
  })

  it("does the same in compact height (the source-edit shape)", () => {
    render(
      <TranslatedEditor
        cellId="cell-wrap-2"
        initialPlain={LONG_URL}
        initialHtml={`<p>${LONG_URL}</p>`}
        onCommit={() => {}}
        compactHeight
      />,
    )
    const surface = document.querySelector(".ProseMirror") as HTMLElement
    expect(surface.className).toContain("break-words")
    expect(surface.className).toContain("min-w-0")
  })
})
