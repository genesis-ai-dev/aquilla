/**
 * AQU-583: the TARGET column header is the discoverable entry point for changing
 * the project's target language. A tester auto-translated into unintended
 * languages and could not find where to change the target language. These tests
 * lock in that the target-language tag is actionable:
 *   - single-lane project → a clickable pill invokes `onEditTargetLanguage`
 *   - multi-lane project   → the lane dropdown appends "Change target language…"
 *   - no target language   → a "Set target language" prompt is shown + clickable
 *   - no handler passed     → the tag stays a static, non-interactive pill
 *     (byte-identical to the pre-AQU-583 header)
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

vi.mock("@/lib/sync/events-emit", () => ({
  emitCellValidate: vi.fn(() => Promise.resolve("validate-event")),
  emitCellUnvalidate: vi.fn(() => Promise.resolve("unvalidate-event")),
  emitTargetCellCommit: vi.fn(() => Promise.resolve("commit-event")),
  emitSourceCellCommit: vi.fn(() => Promise.resolve("source-event")),
  emitCellWaive: vi.fn(() => Promise.resolve("waive-event")),
  emitCellUnwaive: vi.fn(() => Promise.resolve("unwaive-event")),
}))

// happy-dom has no layout engine — render every row (same shim as the lane test).
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

function makeProject(targetLanguage: string): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage,
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    // AQU-608: the lane switcher is intentionally restricted to maintainer+.
    syncRole: { level: ROLE.MAINTAINER, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
  }
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

function makeStore(project: ProjectRecord): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows("cell-1"), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(
  project: ProjectRecord,
  extra: {
    lanes?: string[]
    onLaneChange?: (lane: string) => void
    onEditTargetLanguage?: () => void
  },
) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={makeStore(project)}
          username="tester"
          activeLane=""
          lanes={extra.lanes}
          onLaneChange={extra.onLaneChange}
          onEditTargetLanguage={extra.onEditTargetLanguage}
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

describe("EditorTable — AQU-583 target-language control in the TARGET header", () => {
  it("single-lane project: the target tag is a clickable pill that opens language settings", () => {
    const onEdit = vi.fn()
    renderTable(makeProject("fr"), { onEditTargetLanguage: onEdit })
    const control = screen.getByTestId("edit-target-language")
    expect(control).toHaveTextContent("fr")
    expect(control.getAttribute("aria-label")).toBe("Change target language")
    fireEvent.click(control)
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it("no target language set: prompts to set one and stays actionable", () => {
    const onEdit = vi.fn()
    renderTable(makeProject(""), { onEditTargetLanguage: onEdit })
    const control = screen.getByTestId("edit-target-language")
    expect(control).toHaveTextContent("Set target language")
    fireEvent.click(control)
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it("multi-lane project: the lane dropdown offers a 'Change target language…' item", () => {
    const onEdit = vi.fn()
    renderTable(makeProject("fr"), {
      lanes: ["", "de"],
      onLaneChange: vi.fn(),
      onEditTargetLanguage: onEdit,
    })
    fireEvent.click(screen.getByTestId("lane-switcher"))
    const item = screen.getByTestId("edit-target-language")
    expect(item).toHaveTextContent("Change target language")
    fireEvent.click(item)
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it("no handler passed: the tag is a static, non-interactive pill", () => {
    renderTable(makeProject("fr"), {})
    expect(screen.queryByTestId("edit-target-language")).toBeNull()
    expect(screen.queryByTestId("lane-switcher")).toBeNull()
    // The language is still shown, just not actionable.
    expect(screen.getByText("fr")).toBeInTheDocument()
  })
})
