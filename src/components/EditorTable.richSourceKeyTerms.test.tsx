/**
 * AQU-1135 — a FORMATTED source cell keeps its key terms, and clicking one
 * opens the lookup popover.
 *
 * The source column branches on markup: plain text renders through
 * `SourceWithTermLookup` (a `TermLookupPopover` trigger per match), while a
 * cell carrying inline markup renders through `SanitizedRichHtml`, a bare
 * `dangerouslySetInnerHTML` div. The second path knew nothing about
 * terminology, so on every project whose import produced formatting — DOCX,
 * HTML, EPUB, Biblica, IDML — and on every cell whose source had been edited,
 * the key terms were not highlighted and there was nothing to click. The
 * double-click → "View term" route kept working because it reads the browser
 * selection rather than the rendered spans, which is exactly the asymmetry
 * that was reported.
 *
 * The unit-level rules live in `src/lib/richtext/terminology-html.test.ts`.
 * This is the composition test: the real sanitizer's output, through the real
 * render branch, to the real popover. A decoration that the sanitizer strips,
 * or a highlight nothing has wired a click to, passes there and fails here.
 */

import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { Toaster } from "@/components/ui/toast"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { Concept } from "@/lib/terminology/types"

vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => ({ cursor: null, loading: false }),
}))

// happy-dom has no layout engine — render every row (same shim the other
// EditorTable suites use).
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
            { key: keyExtractor?.(item, index) ?? item.id },
            renderItem({ item, index }),
          ),
        ),
      )
    }),
  }
})

const SPIRIT: Concept = {
  id: "concept-1",
  sourceTerm: "Spirit",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  renderings: [{ rendering: "Ruach", status: "preferred" }],
  notes: "Theological term",
}

const SOURCE_PLAIN = "The Spirit came."
/** What a DOCX/HTML import stores for a cell with one bold word in it. */
const SOURCE_HTML = "The <b>Spirit</b> came."

function makeCell(): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: SOURCE_PLAIN,
    translated: "",
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

function makeRows(valueHtml: string | null): CellRow[] {
  const cell = makeCell()
  return [
    {
      cellId: cell.id, side: "source", value: cell.original, valueHtml,
      type: cell.type, canonicalRef: cell.context, anchorCellId: null,
      eventId: `${cell.id}-source`, sourceEventId: null, lastEditor: null,
      lastEditAt: 1, validated: false, wordCount: 3,
    },
    {
      cellId: cell.id, side: "target", value: "", valueHtml: null,
      type: cell.type, canonicalRef: cell.context, anchorCellId: null,
      eventId: `${cell.id}-target`, sourceEventId: `${cell.id}-source`,
      lastEditor: null, lastEditAt: 2, validated: false, wordCount: 0,
    },
  ]
}

const PROJECT: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "he",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
  terminology: [SPIRIT],
}

function renderTable(valueHtml: string | null) {
  const store = new CellStore()
  store.setRuntime({
    projectId: PROJECT.id, fileId: "file-1", username: "lead",
    requiredValidations: 1, auditStats: new Map(),
  })
  store.replaceRows(makeRows(valueHtml), { full: true, maxServerSeq: 1 })

  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Toaster />
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={PROJECT}
          cellStore={store}
          username="lead"
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

/** The source column's clickable key-term hosts, formatted or not. */
function sourceTermHosts(): HTMLElement[] {
  const source = document.querySelector('[data-editor-cell-surface="source"]')
  return [...(source?.querySelectorAll<HTMLElement>("[data-source-term]") ?? [])]
}

describe("EditorTable — key terms in a formatted source cell (AQU-1135)", () => {
  it("highlights the managed term in a source cell that carries inline markup", async () => {
    renderTable(SOURCE_HTML)
    await screen.findByText(/came\./)

    const hosts = sourceTermHosts()
    expect(hosts).toHaveLength(1)
    expect(hosts[0]).toHaveTextContent("Spirit")
    expect(hosts[0]).toHaveClass("terminology-highlight")
    // The formatting the branch exists to render is still there.
    expect(
      document.querySelector('[data-editor-cell-surface="source"] b'),
    ).not.toBeNull()
  })

  it("opens the term lookup popover on a single click of the highlight", async () => {
    renderTable(SOURCE_HTML)
    await screen.findByText(/came\./)

    expect(screen.queryByText("Ruach")).not.toBeInTheDocument()
    fireEvent.click(sourceTermHosts()[0])

    // The popover body, anchored on the clicked highlight.
    expect(await screen.findByText("Ruach")).toBeInTheDocument()
    expect(screen.getByText("Theological term")).toBeInTheDocument()
  })

  it("opens the same popover from the keyboard", async () => {
    renderTable(SOURCE_HTML)
    await screen.findByText(/came\./)

    const host = sourceTermHosts()[0]
    expect(host.getAttribute("role")).toBe("button")
    fireEvent.keyDown(host, { key: "Enter" })

    expect(await screen.findByText("Ruach")).toBeInTheDocument()
  })

  it("still highlights the term when the source cell is plain text", async () => {
    // The path that always worked — pinned so the fix cannot be "made to pass"
    // by moving formatted cells onto a plain renderer and losing their markup.
    renderTable(null)
    await screen.findByText(/came\./)

    const source = document.querySelector('[data-editor-cell-surface="source"]')
    expect(source?.querySelector(".terminology-highlight")).not.toBeNull()
    expect(source?.textContent).toContain(SOURCE_PLAIN)
  })
})
