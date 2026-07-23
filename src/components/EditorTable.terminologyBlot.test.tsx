/**
 * AQU-664 — terminology violations surface only via the inline blot, not the
 * amber "Terminology advisory" band.
 *
 * Before AQU-664 the editor showed TWO signals for a forbidden rendering: an
 * amber advisory band (PreAcceptanceWarningBand) AND the inline
 * `violation-blot-term` decoration. The band was removed so a terminology
 * violation shows exactly one signal. This test reproduces the exact condition
 * that used to render the band — an ACTIVE concept whose source term is in the
 * cell source and whose FORBIDDEN rendering is in the committed target — and
 * asserts the band no longer appears.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
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

// A concept that forbids the rendering "verboten" for source term "sample".
const FORBIDDEN_CONCEPT: Concept = {
  id: "concept-1",
  sourceTerm: "sample",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  renderings: [{ rendering: "verboten", status: "forbidden" }],
}

function makeCell(): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "This is a sample.",
    translated: "verboten", // the forbidden rendering, committed
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

function makeRows(cells: CellData[]): CellRow[] {
  return cells.flatMap((cell, index) => {
    const canonicalRef = cell.context || cell.group || null
    const anchorCellId = index > 0 ? cells[index - 1].id : null
    return [
      {
        cellId: cell.id, side: "source", value: cell.original, valueHtml: null,
        type: cell.type, canonicalRef, anchorCellId, eventId: `${cell.id}-source`,
        sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false,
        wordCount: cell.original.trim().split(/\s+/).filter(Boolean).length,
      },
      {
        cellId: cell.id, side: "target", value: cell.translated, valueHtml: null,
        type: cell.type, canonicalRef, anchorCellId, eventId: `${cell.id}-target`,
        sourceEventId: `${cell.id}-source`, lastEditor: "lead", lastEditAt: 2, validated: false,
        wordCount: cell.translated.trim().split(/\s+/).filter(Boolean).length,
      },
    ]
  })
}

function makeStore(cells: CellData[], projectId: string): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId, fileId: "file-1", username: "lead", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows(cells), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(project: ProjectRecord) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={makeStore([makeCell()], project.id)}
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

describe("EditorTable — terminology advisory band removed (AQU-664)", () => {
  it("does not render the amber 'Terminology advisory' band for a forbidden rendering", async () => {
    const project: ProjectRecord = {
      id: "proj-1",
      name: "Test Project",
      sourceLanguage: "en",
      targetLanguage: "fr",
      createdAt: "2026-01-01T00:00:00Z",
      files: [],
      members: [],
      terminology: [FORBIDDEN_CONCEPT],
    }
    renderTable(project)
    // The row mounted (target text visible)…
    await screen.findByText("verboten")
    // …but the advisory band that used to accompany it is gone.
    expect(screen.queryByText(/Terminology advisory/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Forbidden rendering/i)).not.toBeInTheDocument()
  })
})
