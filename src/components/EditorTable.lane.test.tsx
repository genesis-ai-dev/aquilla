/**
 * AQU-538 (slice 2): the active target LANE threads from ProjectWorkspace
 * through EditorTable → MemoizedRow → EditorRow into the target-side emits.
 * This test renders the real EditorTable with a non-default `activeLane`,
 * clicks the row's validation affordance, and proves the emitted
 * `cell.validate` carries `targetLang` — the same prop path the hand-edit
 * `target.cell.commit` uses. The default lane (`''`) is asserted separately to
 * lock in the byte-identical N=1 wire.
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
import { ROLE } from "@/lib/frontier/roles"
import type { MemberScope } from "@/lib/sync/member-scopes"

// Capture target-side emits without touching IndexedDB / posthog. Every helper
// EditorTable imports must be present so the module resolves. `vi.hoisted`
// lets the spies exist before the hoisted `vi.mock` factory runs.
const { emitCellValidate, emitCellUnvalidate, emitTargetCellCommit } = vi.hoisted(() => ({
  emitCellValidate: vi.fn(() => Promise.resolve("validate-event")),
  emitCellUnvalidate: vi.fn(() => Promise.resolve("unvalidate-event")),
  emitTargetCellCommit: vi.fn(() => Promise.resolve("commit-event")),
}))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellValidate,
  emitCellUnvalidate,
  emitTargetCellCommit,
  emitSourceCellCommit: vi.fn(() => Promise.resolve("source-event")),
  emitCellWaive: vi.fn(() => Promise.resolve("waive-event")),
  emitCellUnwaive: vi.fn(() => Promise.resolve("unwaive-event")),
}))

// happy-dom has no layout engine — replace the virtualized list with a trivial
// "render every row" stand-in (same shim as EditorTable.editorActions.test).
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

const project: ProjectRecord = {
  id: "proj-1",
  name: "Test Project",
  sourceLanguage: "en",
  targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [],
  members: [],
  // project_lead (500): canValidate true, passes canPerform("cell.validate").
  syncRole: { level: ROLE.PROJECT_LEAD, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
}

function makeRows(id: string): CellRow[] {
  return [
    {
      cellId: id, side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: id, side: "target", value: "bonjour", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-target`,
      sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
    },
  ]
}

function makeStore(cellId: string): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cellId), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(activeLane: string, myScopes: MemberScope[] = []) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{ myScopes }}>
        <EditorTable
          project={project}
          cellStore={makeStore("cell-1")}
          username="tester"
          activeLane={activeLane}
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

describe("EditorTable — active lane threads into target-side emits", () => {
  it("carries the active lane as targetLang on validate", async () => {
    emitCellValidate.mockClear()
    renderTable("fr")
    const button = await screen.findByRole("button", { name: /Click to validate/ })
    fireEvent.click(button)
    expect(emitCellValidate).toHaveBeenCalledTimes(1)
    expect(emitCellValidate).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: "cell-1", editEventId: "cell-1-target", targetLang: "fr" }),
    )
  })

  it("passes the default lane ('') unchanged so N=1 stays byte-identical", async () => {
    emitCellValidate.mockClear()
    renderTable("")
    const button = await screen.findByRole("button", { name: /Click to validate/ })
    fireEvent.click(button)
    expect(emitCellValidate).toHaveBeenCalledTimes(1)
    expect(emitCellValidate).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: "cell-1", targetLang: "" }),
    )
  })

  it("AQU-633: disables the per-cell validate action outside the member's lane scope", async () => {
    emitCellValidate.mockClear()
    renderTable("fr", [{ kind: "lane", value: "es" }])

    const button = await screen.findByRole("button", { name: /Click to validate/ })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(emitCellValidate).not.toHaveBeenCalled()
  })
})
