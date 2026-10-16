/**
 * AQU-1634 — the violation rule card is one surface.
 *
 * Clicking a check's underline opens a rule card (with Waive) in the
 * bottom-right toast stack. Two bugs shipped with it:
 *
 *  1. Escape did not close the card.
 *  2. `openRuleId` lived in each EditorRow's own `useState`, so clicking a
 *     SECOND row's underline left the first row's card mounted and stacked a
 *     second card on top.
 *
 * The unit-level guards live in `src/lib/rules/open-rule-card.test.ts` and
 * `ViolationToast.test.tsx`; this covers the composition that actually broke —
 * two real rows in a real table, driven by clicks.
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
import type { ProjectRecord, RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import type { Concept } from "@/lib/terminology/types"
import { resetRuleCardForTests } from "@/lib/rules/open-rule-card"

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

const RULE_ID = "term:concept-1:forbidden:verboten"

// A concept that forbids the rendering "verboten" for source term "sample".
const FORBIDDEN_CONCEPT: Concept = {
  id: "concept-1",
  sourceTerm: "sample",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  renderings: [{ rendering: "verboten", status: "forbidden" }],
}

const RULE: TranslationRule = {
  id: RULE_ID,
  name: "Term: sample — forbidden: verboten",
  description: "Do not use this rendering",
  severity: "major",
  source: "user",
  scope: "project",
  check: { type: "target-forbids", targetPattern: "verboten" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
}

function makeCell(id: string, context: string): CellData {
  return {
    id,
    fileId: "file-1",
    original: "This is a sample.",
    translated: "verboten", // the forbidden rendering, committed
    context,
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

const CELLS = [makeCell("cell-1", "GEN 1:1"), makeCell("cell-2", "GEN 1:2")]

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

const PROJECT: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "de",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
  terminology: [FORBIDDEN_CONCEPT],
}

function infractionFor(cellId: string): RuleInfraction {
  return {
    ruleId: RULE_ID,
    cellId,
    fileId: "file-1",
    reason: "target-forbids",
    spans: [{ side: "target", start: 0, end: 8, matchedText: "verboten" }],
  }
}

function renderTable(extra: Partial<ComponentProps<typeof EditorTable>> = {}) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <Toaster />
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={PROJECT}
          cellStore={makeStore(CELLS, PROJECT.id)}
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
          infractions={new Map([
            ["cell-1", [infractionFor("cell-1")]],
            ["cell-2", [infractionFor("cell-2")]],
          ])}
          rules={[RULE]}
          {...extra}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

/** The target-side violation underlines, one per row, in row order. */
async function findBlots(): Promise<HTMLElement[]> {
  return waitFor(() => {
    const found = Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-target-read-view] [data-rule-id="${RULE_ID}"]`,
      ),
    )
    expect(found.length).toBeGreaterThanOrEqual(2)
    return found
  })
}

function openCards(): NodeListOf<Element> {
  return document.querySelectorAll('[data-slot="toast"]')
}

afterEach(() => {
  toast.close()
  resetRuleCardForTests()
})

describe("EditorTable — the rule card is a single surface (AQU-1634)", () => {
  it("replaces the open card when another row's underline is clicked", async () => {
    renderTable()
    const blots = await findBlots()

    fireEvent.click(blots[0])
    await screen.findByRole("button", { name: /waive/i })
    await waitFor(() => expect(openCards()).toHaveLength(1))

    // Before AQU-1634 this stacked a second card, because each row kept its
    // own `openRuleId`.
    fireEvent.click(blots[1])
    await waitFor(() => expect(openCards()).toHaveLength(1))
    expect(await screen.findByRole("button", { name: /waive/i })).toBeInTheDocument()
  })

  it("still shows exactly one card when the same underline is clicked twice", async () => {
    renderTable()
    const blots = await findBlots()

    fireEvent.click(blots[0])
    await screen.findByRole("button", { name: /waive/i })
    fireEvent.click(blots[0])

    await waitFor(() => expect(openCards()).toHaveLength(1))
  })

  it("closes the card on Escape", async () => {
    renderTable()
    const blots = await findBlots()

    fireEvent.click(blots[0])
    await screen.findByRole("button", { name: /waive/i })

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(openCards()).toHaveLength(0))
    expect(screen.queryByRole("button", { name: /waive/i })).toBeNull()
  })

  it("reopens after Escape, so closing does not strand the card", async () => {
    renderTable()
    const blots = await findBlots()

    fireEvent.click(blots[0])
    await screen.findByRole("button", { name: /waive/i })
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(openCards()).toHaveLength(0))

    fireEvent.click(blots[1])

    await screen.findByRole("button", { name: /waive/i })
    await waitFor(() => expect(openCards()).toHaveLength(1))
  })
})
