/**
 * AQU-757 — hovering a flagged cell names the check and why it fired.
 *
 * The tint and the health ribbon used to say only that something was wrong.
 * This feeds a real rule-engine infraction (number integrity, end punctuation,
 * and a user rule) through EditorTable and reads it back off the hover.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { Toaster, toast } from "@/components/ui/toast"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"
import { resolveBuiltinRules } from "@/lib/lqa/builtin-resolver"
import { resetRuleCardForTests } from "@/lib/rules/open-rule-card"
import { checkRulesForCell } from "@/lib/rules/rule-engine"

vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => ({ cursor: null, loading: false }),
}))

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

const USER_RULE: TranslationRule = {
  id: "user:no-foo",
  name: "No foo",
  description: "Do not write foo",
  severity: "minor",
  source: "user",
  scope: "project",
  check: { type: "target-forbids", targetPattern: "\\bfoo\\b" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
}

const CELL: CellData = {
  id: "cell-1",
  fileId: "file-1",
  original: "Isaiah 40:25.",
  translated: "Isaias foo",
  context: "ISA 40:25",
  group: "ISA 40",
  type: "text",
  status: "unvalidated",
  validationStatus: "none",
  activeValidators: [],
  validationHistory: [],
  history: [],
  threads: [],
}

const PROJECT: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "es",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

const RULES = [
  ...resolveBuiltinRules(undefined).filter((rule) =>
    rule.id === "builtin:number-integrity" || rule.id === "builtin:end-punctuation-mismatch",
  ),
  USER_RULE,
]

function renderTable() {
  const store = new CellStore()
  store.setRuntime({
    projectId: PROJECT.id, fileId: "file-1", username: "lead",
    requiredValidations: 1, auditStats: new Map(),
  })
  const rows: CellRow[] = [
    {
      cellId: CELL.id, side: "source", value: CELL.original, valueHtml: null,
      type: CELL.type, canonicalRef: CELL.context, anchorCellId: null,
      eventId: `${CELL.id}-source`, sourceEventId: null, lastEditor: null,
      lastEditAt: 1, validated: false, wordCount: 2,
    },
    {
      cellId: CELL.id, side: "target", value: CELL.translated, valueHtml: null,
      type: CELL.type, canonicalRef: CELL.context, anchorCellId: null,
      eventId: `${CELL.id}-target`, sourceEventId: `${CELL.id}-source`,
      lastEditor: "lead", lastEditAt: 2, validated: false, wordCount: 2,
    },
  ]
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  const infractions = checkRulesForCell(CELL, CELL.fileId, RULES)

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
          lineNumbersEnabled
          cellLabelsEnabled={false}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
          infractions={new Map([[CELL.id, infractions]])}
          rules={RULES}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

async function tooltipOf(element: HTMLElement) {
  fireEvent.mouseEnter(element)
  fireEvent.pointerEnter(element)
  fireEvent.focus(element)
  return screen.findByRole("tooltip")
}

afterEach(() => {
  toast.close()
  resetRuleCardForTests()
})

describe("EditorTable — integrity flag hover (AQU-757)", () => {
  it("names every active check on the line number and the health ribbon", async () => {
    renderTable()

    const flag = screen.getByTestId("cell-issue-flag")
    expect(flag).toHaveAccessibleName(/Number integrity — Number from source missing in translation/)
    expect(flag).toHaveAccessibleName(/End punctuation — Terminal punctuation differs from source/)
    expect(flag).toHaveAccessibleName(/No foo — target contains forbidden pattern/)

    const flagTip = await tooltipOf(flag)
    expect(flagTip).toHaveTextContent("Number integrity — Number from source missing in translation")
    expect(flagTip).toHaveTextContent("End punctuation — Terminal punctuation differs from source")
    expect(flagTip).toHaveTextContent("No foo — target contains forbidden pattern")

    const ribbon = screen.getByTestId("health-ribbon")
    expect(ribbon).toHaveAccessibleName(/End punctuation — Terminal punctuation differs from source/)
    const ribbonTip = await tooltipOf(ribbon)
    expect(ribbonTip).toHaveTextContent("Number integrity — Number from source missing in translation")
    expect(ribbonTip).not.toHaveTextContent(/automatic issue/i)
  })

  it("still opens waive from the underlined check", async () => {
    renderTable()
    const underline = document.querySelector<HTMLElement>(
      '[data-editor-cell-surface="source"] [data-rule-id="builtin:number-integrity"]',
    )
    expect(underline).not.toBeNull()
    fireEvent.click(underline!)
    expect(await screen.findByRole("button", { name: /waive/i })).toBeInTheDocument()
  })
})
