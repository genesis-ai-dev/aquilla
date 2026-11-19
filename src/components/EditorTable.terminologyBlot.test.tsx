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

import { afterEach, describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode, ComponentProps } from "react"
import { EditorTable } from "./EditorTable"
import { Toaster, toast } from "@/components/ui/toast"
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

function renderTable(
  project: ProjectRecord,
  extra: Partial<ComponentProps<typeof EditorTable>> = {},
) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <Toaster />
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
          {...extra}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

// An approved concept whose rendering the committed target does not use: the
// compiled `term:` rule blots the SOURCE term (source-requires-target).
const APPROVED_PROJECT: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "es",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
  terminology: [{
    id: "concept-1",
    sourceTerm: "sample",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    renderings: [{ rendering: "muestra", status: "preferred" }],
  }],
}

const SOURCE_SPAN_INFRACTIONS = new Map([
  ["cell-1", [{
    ruleId: "term:concept-1:approved",
    cellId: "cell-1",
    fileId: "file-1",
    reason: "source-requires-target" as const,
    spans: [{ side: "source" as const, start: 10, end: 16, matchedText: "sample" }],
  }]],
])

const APPROVED_RULE: NonNullable<ComponentProps<typeof EditorTable>["rules"]>[number] = {
  id: "term:concept-1:approved",
  name: "Term: sample",
  description: "Use an approved rendering",
  severity: "major",
  source: "user",
  scope: "project",
  check: {
    type: "source-requires-target",
    sourcePattern: "sample",
    targetPattern: "muestra",
  },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
}

afterEach(() => toast.close())

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

  it("blots the source term when a terminology infringement has a source span", async () => {
    const approved: Concept = {
      id: "concept-1",
      sourceTerm: "sample",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      renderings: [{ rendering: "muestra", status: "preferred" }],
    }
    const project: ProjectRecord = {
      id: "proj-1",
      name: "Test Project",
      sourceLanguage: "en",
      targetLanguage: "es",
      createdAt: "2026-01-01T00:00:00Z",
      files: [],
      members: [],
      terminology: [approved],
    }
    const infractions = new Map([
      ["cell-1", [{
        ruleId: "term:concept-1:approved",
        cellId: "cell-1",
        fileId: "file-1",
        reason: "source-requires-target" as const,
        spans: [{ side: "source" as const, start: 10, end: 16, matchedText: "sample" }],
      }]],
    ])
    renderTable(project, { infractions })
    await screen.findByText("sample")
    const blot = document.querySelector('[data-rule-id="term:concept-1:approved"]')
    expect(blot).toHaveClass("terminology-highlight")
    expect(blot).toHaveClass("underline", "decoration-wavy", "decoration-red-500")
    expect(document.querySelectorAll(".terminology-highlight").length).toBeGreaterThanOrEqual(2)
    expect(document.querySelector(".decoration-dotted")).toBeNull()
  })

  // A source term with a finding is two things at once: the lookup trigger
  // and, inside it, the finding's underline. The underline used to keep the
  // click to itself, so the mouse reached the rule card and never the lookup —
  // on exactly the terms whose approved rendering the translator needs to
  // read. Keyboard users were unaffected (Enter on the trigger), which is why
  // an RTL click on the trigger alone never saw it: the click has to land on
  // the text, inside the row, as a pointer does.
  it("opens the term lookup as well as the violation toast when a blotted source term is clicked", async () => {
    renderTable(APPROVED_PROJECT, { infractions: SOURCE_SPAN_INFRACTIONS, rules: [APPROVED_RULE] })

    const blot = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-rule-id="term:concept-1:approved"]',
      )
      expect(element).not.toBeNull()
      return element!
    })
    expect(blot.closest('[data-slot="popover-trigger"]')).not.toBeNull()
    await userEvent.click(blot)

    // The lookup, with the rendering the finding is about…
    const lookup = await screen.findByRole("tooltip", { name: /terminology lookup/i })
    expect(lookup).toHaveTextContent("muestra")
    expect(document.querySelectorAll('[data-slot="popover-content"]')).toHaveLength(1)
    // …and the finding's own card, once.
    await screen.findByRole("button", { name: /waive/i })
    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1)
    })
  })

  it("opens the term lookup when a source term with no finding is clicked in the row", async () => {
    renderTable(APPROVED_PROJECT)

    const trigger = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-cell-type="source"] .terminology-highlight[data-slot="popover-trigger"]',
      )
      expect(element).not.toBeNull()
      return element!
    })
    await userEvent.click(trigger)

    const lookup = await screen.findByRole("tooltip", { name: /terminology lookup/i })
    expect(lookup).toHaveTextContent("muestra")
    // No finding, so no card.
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it("keeps Enter on the trigger opening the lookup alone, finding or not", async () => {
    renderTable(APPROVED_PROJECT, { infractions: SOURCE_SPAN_INFRACTIONS, rules: [APPROVED_RULE] })

    const trigger = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-cell-type="source"] .terminology-highlight[data-slot="popover-trigger"]',
      )
      expect(element).not.toBeNull()
      return element!
    })
    trigger.focus()
    await userEvent.keyboard("{Enter}")

    await screen.findByRole("tooltip", { name: /terminology lookup/i })
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it("shows the target blot violation in a bottom-right toast without opening details", async () => {
    const project: ProjectRecord = {
      id: "proj-1",
      name: "Test Project",
      sourceLanguage: "en",
      targetLanguage: "de",
      createdAt: "2026-01-01T00:00:00Z",
      files: [],
      members: [],
      terminology: [FORBIDDEN_CONCEPT],
    }
    const infractions = new Map([
      ["cell-1", [{
        ruleId: "term:concept-1:forbidden:verboten",
        cellId: "cell-1",
        fileId: "file-1",
        reason: "target-forbids" as const,
        spans: [{ side: "target" as const, start: 0, end: 8, matchedText: "verboten" }],
      }]],
    ])
    renderTable(project, {
      infractions,
      rules: [{
        id: "term:concept-1:forbidden:verboten",
        name: "Term: sample — forbidden: verboten",
        description: "Do not use this rendering",
        severity: "major",
        source: "user",
        scope: "project",
        check: { type: "target-forbids", targetPattern: "verboten" },
        enabled: true,
        createdAt: "2026-01-01T00:00:00Z",
      }],
    })

    const blot = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-target-read-view] [data-rule-id="term:concept-1:forbidden:verboten"]',
      )
      expect(element).not.toBeNull()
      return element!
    })
    expect(blot).toHaveClass("terminology-highlight")
    expect(blot).toHaveClass("underline", "decoration-wavy", "decoration-red-500")
    fireEvent.click(blot)

    await screen.findByRole("button", { name: /waive/i })
    expect(document.querySelector('[data-slot="toast-viewport"]')).toHaveClass(
      "bottom-4",
      "sm:right-4",
      "sm:left-auto",
    )
    expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Open cell details" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Close cell details" })).toBeNull()
  })
})
