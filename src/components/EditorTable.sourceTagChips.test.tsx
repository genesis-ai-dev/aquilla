/**
 * AQU-793 — a cell that knows what it IS says so on the row.
 *
 * Reinier de Blois's v1 feedback on the SDBH lexicon import: every cell must
 * be tagged with its content type (gloss / definition / contextual meaning),
 * and a cell may carry several tags (headword + part). Importers put those
 * labels in `cell.metadata.tags`; the source context line renders them as
 * chips. This pins the contract: a flat string list renders chips in order,
 * anything else (absent, a DCS TSV "Tags" string, an empty list) renders
 * nothing so ordinary rows stay untouched.
 *
 * happy-dom has no layout engine, so this asserts structure, not geometry.
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
  sourceLanguage: "hbo",
  targetLanguage: "es",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

function makeRows(id: string, metadata: Record<string, unknown> | null): CellRow[] {
  return [
    {
      cellId: id, side: "source", value: "blossom; flower", valueHtml: null, type: "text",
      canonicalRef: null, anchorCellId: null, eventId: `${id}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 2,
      metadata,
    },
    {
      cellId: id, side: "target", value: "flor", valueHtml: null, type: "text",
      canonicalRef: null, anchorCellId: null, eventId: `${id}-target`,
      sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
    },
  ]
}

function renderTable(metadata: Record<string, unknown> | null) {
  const store = new CellStore()
  store.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows("sdbh-000001001001000-glosses", metadata), { full: true, maxServerSeq: 1 })
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
          lineNumbersEnabled={false}
          cellLabelsEnabled={false}
          sourceTextDirection="rtl"
          targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

describe("source tag chips (AQU-793)", () => {
  it("renders every tag from metadata.tags, in order, inside the source context line", () => {
    renderTable({ tags: ["אֵב", "Contextual meaning", "Gloss"] })
    const chips = screen.getByTestId("source-tag-chips")
    expect(screen.getByTestId("source-context-line")).toContainElement(chips)
    expect(Array.from(chips.children).map((c) => c.textContent)).toEqual(["אֵב", "Contextual meaning", "Gloss"])
    // A Hebrew headword next to an English label: each chip picks its own direction.
    expect(Array.from(chips.children).every((c) => c.getAttribute("dir") === "auto")).toBe(true)
  })

  it("renders nothing for cells without a tag list", () => {
    renderTable(null)
    expect(screen.queryByTestId("source-tag-chips")).toBeNull()
  })

  it("ignores a non-list tags value (a DCS TSV \"Tags\" column is a string) and an empty list", () => {
    const { unmount } = renderTable({ tags: "keyterm; culture" })
    expect(screen.queryByTestId("source-tag-chips")).toBeNull()
    unmount()
    renderTable({ tags: [] })
    expect(screen.queryByTestId("source-tag-chips")).toBeNull()
  })
})
