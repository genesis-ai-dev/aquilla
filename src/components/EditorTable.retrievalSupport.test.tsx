/**
 * Retrieval-support summary — WHY: the support percentage lives in a paragraph
 * that is deliberately muted and is the figure a reviewer is reading for. It
 * carries `font-medium text-foreground` to lift it out of the explanatory copy.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/hooks/useMicPermission", () => ({
  useMicPermission: () => ({ micDenied: true }),
}))

// happy-dom has no layout engine, so the real virtualized list may decide no
// rows are visible. Render every row instead — same stand-in the other
// EditorTable tests use.
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
        getState: () => ({
          scroll: 0,
          positionAtIndex: (index: number) => index * 140,
          sizeAtIndex: () => 140,
        }),
        scrollToIndex: async () => undefined,
        scrollToOffset: async () => undefined,
      }))

      return React.createElement(
        "div",
        null,
        data.map((item, index) => (
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? item },
            renderItem({ item, index }),
          )
        )),
      )
    }),
  }
})

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
}

function makeStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  const rows: CellRow[] = [
    {
      cellId: "cell-1",
      side: "source",
      value: "hello",
      valueHtml: null,
      type: "text",
      canonicalRef: "GEN 1:1",
      anchorCellId: null,
      eventId: "cell-1-source",
      sourceEventId: null,
      lastEditor: null,
      lastEditAt: 1,
      validated: false,
      wordCount: 1,
    },
    {
      cellId: "cell-1",
      side: "target",
      value: "bonjour",
      valueHtml: null,
      type: "text",
      canonicalRef: "GEN 1:1",
      anchorCellId: null,
      eventId: "cell-1-target",
      sourceEventId: "cell-1-source",
      lastEditor: "tester",
      lastEditAt: 2,
      validated: false,
      wordCount: 1,
      endorsementCount: 3,
    },
  ]
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

describe("EditorTable retrieval-support summary", () => {
  it("keeps the support percentage emphasised", async () => {
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <EditorActionsProvider value={{}}>
          <EditorTable
            project={project}
            cellStore={makeStore()}
            username="tester"
            isCompletionConfigured={false}
            isCompletionAvailable={false}
            completing={new Map()}
            examples={new Map()}
            errors={new Map()}
            previews={new Map()}
            onCompleteSingle={() => {}}
            onCompleteBatch={() => {}}
            healthMap={new Map([["cell-1", 72]])}
            lineNumbersEnabled={false}
            cellLabelsEnabled={false}
            sourceTextDirection="ltr"
            targetTextDirection="ltr"
          />
        </EditorActionsProvider>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Open cell details" }))
    fireEvent.click(await screen.findByRole("tab", { name: "Retrieval support" }))

    // Both the cell estimate and its local trend are the same for this one-cell
    // fixture. Assert the elements and their classes; a text-only assertion
    // would pass if the figures sank back into the muted explanatory copy.
    const percentages = screen.getAllByText("72%")
    expect(percentages).toHaveLength(2)
    for (const percent of percentages) {
      expect(percent.tagName).toBe("SPAN")
      expect(percent).toHaveClass("font-medium")
      expect(percent).toHaveClass("text-foreground")
    }
  })
})
