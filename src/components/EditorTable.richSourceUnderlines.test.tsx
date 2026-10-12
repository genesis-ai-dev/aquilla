/**
 * AQU-1757 — a FORMATTED source cell keeps its rule underlines.
 *
 * A source cell that carries markup (any hand edit saves one; DOCX, IDML and
 * other formatted imports arrive with one) renders through `SanitizedRichHtml`
 * instead of the plain-text path, and that path drew no findings at all: the
 * row number turned red and the Issues tab listed the finding, but nothing in
 * the source was underlined. Sam hit it in the AQU-1667 review by editing a
 * row's source.
 *
 * The unit-level placement rules live in
 * `src/lib/richtext/rule-ranges-html.test.ts`. This is the composition test:
 * the real sanitizer, the real render branch, the real rule card.
 */

import { afterEach, describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { Toaster, toast } from "@/components/ui/toast"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { ProjectRecord, RuleInfraction, TranslationRule } from "@/lib/parsers/types"
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

const RULE_ID = "builtin:number-integrity"

const RULE: TranslationRule = {
  id: RULE_ID,
  name: "Number integrity",
  description: "Number from source missing in translation",
  severity: "major",
  source: "user",
  scope: "project",
  check: { type: "target-forbids", targetPattern: "never-matches" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
}

const SOURCE_PLAIN = "Psalm 119 has verses."
/** What a hand edit of the source stores: the same text, with markup. */
const SOURCE_HTML = "<p>Psalm <b>119</b> has verses.</p>"

function makeCell(): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: SOURCE_PLAIN,
    translated: "भजन ११ में पद हैं।",
    context: "PSA 119:1",
    group: "PSA 119",
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
      lastEditAt: 1, validated: false, wordCount: 4,
    },
    {
      cellId: cell.id, side: "target", value: cell.translated, valueHtml: null,
      type: cell.type, canonicalRef: cell.context, anchorCellId: null,
      eventId: `${cell.id}-target`, sourceEventId: `${cell.id}-source`,
      lastEditor: "lead", lastEditAt: 2, validated: false, wordCount: 4,
    },
  ]
}

const INFRACTION: RuleInfraction = {
  ruleId: RULE_ID,
  cellId: "cell-1",
  fileId: "file-1",
  reason: "target-forbids",
  spans: [{ side: "source", start: 6, end: 9, matchedText: "119" }],
}

const PROJECT: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "hi",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
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
          infractions={new Map([["cell-1", [INFRACTION]]])}
          rules={[RULE]}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

/** The source column's underline for the finding, plain or formatted. */
async function findSourceUnderline(): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      `[data-editor-cell-surface="source"] [data-rule-id="${RULE_ID}"]`,
    )
    expect(found).not.toBeNull()
    return found!
  })
}

afterEach(() => {
  toast.close()
  resetRuleCardForTests()
})

describe("EditorTable — rule underlines in a formatted source cell (AQU-1757)", () => {
  it("underlines the finding in a source cell that carries markup", async () => {
    renderTable(SOURCE_HTML)
    const underline = await findSourceUnderline()

    expect(underline).toHaveTextContent("119")
    expect(underline).toHaveClass("underline", "decoration-wavy", "decoration-red-500")
    // The markup the branch exists to render is still there, around it.
    expect(underline.closest("b")).not.toBeNull()
  })

  it("opens the rule card on a click, as the plain path does", async () => {
    renderTable(SOURCE_HTML)
    fireEvent.click(await findSourceUnderline())

    expect(await screen.findByRole("button", { name: /waive/i })).toBeInTheDocument()
  })

  it("opens the rule card from the keyboard", async () => {
    renderTable(SOURCE_HTML)
    const underline = await findSourceUnderline()
    expect(underline).toHaveAttribute("role", "button")

    fireEvent.keyDown(underline, { key: "Enter" })

    expect(await screen.findByRole("button", { name: /waive/i })).toBeInTheDocument()
  })

  it("draws the same underline on a plain source cell (the path that always worked)", async () => {
    renderTable(null)
    const underline = await findSourceUnderline()

    expect(underline).toHaveTextContent("119")
    expect(underline).toHaveClass("underline", "decoration-wavy", "decoration-red-500")
    fireEvent.click(underline)
    expect(await screen.findByRole("button", { name: /waive/i })).toBeInTheDocument()
  })
})
