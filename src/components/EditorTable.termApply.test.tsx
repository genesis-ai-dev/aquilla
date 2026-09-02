/**
 * AQU-1102 — the source-column term popover is READ-ONLY.
 *
 * The defect: `SourceWithTermLookup` mounted `TermLookupPopover` with an
 * `onApply` handler unconditionally, so every preferred/admitted rendering got
 * an Apply button. Clicking it ran `handleTermApply`, which — finding no
 * captured target selection — *appended* the rendering to the target cell and
 * committed it, rewriting a translation the user never touched.
 *
 * The rule (AQU-204): Apply may only mutate the target when the translator has
 * the target cell focused with a text selection. Clicking a source token
 * collapses any such selection into the source column, so the source-column
 * lookup is read-only by construction — the Apply affordance must not render at
 * all, and no `target.cell.commit` may be emitted.
 *
 * This test sits at the EditorTable level because that is where the bug
 * escaped: `TermLookupPopover` itself already honoured "no onApply → no Apply
 * button"; the wiring was what handed it one.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
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

// An active concept for source term "sample" with a preferred, an admitted and
// a forbidden rendering — the shape that used to render two Apply buttons.
const CONCEPT: Concept = {
  id: "concept-1",
  sourceTerm: "sample",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  renderings: [
    { rendering: "muestra", status: "preferred" },
    { rendering: "ejemplo", status: "admitted" },
    { rendering: "verboten", status: "forbidden" },
  ],
}

const SOURCE_TEXT = "This is a sample of text"
const TARGET_TEXT = "Esto es una prueba."

function makeCell(): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: SOURCE_TEXT,
    translated: TARGET_TEXT,
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

function renderTable(onOptimisticEdit: (cellId: string, draft: { value: string; valueHtml?: string }) => void) {
  const project: ProjectRecord = {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "es",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    terminology: [CONCEPT],
  }
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
          onOptimisticEdit={onOptimisticEdit}
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

describe("EditorTable — source-column term lookup is read-only (AQU-1102)", () => {
  it("opens the popover with renderings listed and no Apply buttons", async () => {
    renderTable(() => {})

    // The flagged source token carries the dotted-underline popover trigger.
    fireEvent.click(await screen.findByText("sample"))

    // Renderings are surfaced for review…
    expect(await screen.findByText("muestra")).toBeInTheDocument()
    expect(screen.getByText("ejemplo")).toBeInTheDocument()
    // …including the forbidden one, which never gets an Apply on any surface.
    expect(screen.getByText("verboten")).toBeInTheDocument()

    // …but nothing here can write to the target.
    expect(screen.queryByRole("button", { name: /Apply rendering/i })).not.toBeInTheDocument()
  })

  it("does not touch the target cell when the popover is interacted with", async () => {
    // `onOptimisticEdit` is the first thing handleEditorCommit calls on the way
    // to the outbox, so it stands in for "a target.cell.commit was emitted".
    const onOptimisticEdit = vi.fn()
    renderTable(onOptimisticEdit)

    fireEvent.click(await screen.findByText("sample"))
    const popover = (await screen.findByText("muestra")).closest("[role='tooltip']")
    expect(popover).not.toBeNull()

    // Every affordance the popover offers is inert. Before the fix this clicked
    // the Apply buttons, which appended "muestra" to the target and committed.
    fireEvent.click(screen.getByText("muestra"))
    for (const button of Array.from(popover!.querySelectorAll("button"))) {
      fireEvent.click(button)
    }

    expect(onOptimisticEdit).not.toHaveBeenCalled()
    expect(screen.getByText(TARGET_TEXT)).toBeInTheDocument()
  })
})
