/**
 * AQU-538 (slice 2): the active target LANE threads from ProjectWorkspace
 * through EditorTable → MemoizedRow → EditorRow into the target-side emits.
 * This test renders the real EditorTable with a non-default `activeLane`,
 * clicks the row's validation affordance, and proves the emitted
 * `cell.validate` carries `targetLang` — the same prop path the hand-edit
 * `target.cell.commit` uses. The default lane (`''`) is asserted separately to
 * lock in the byte-identical N=1 wire.
 */

import { afterEach, describe, it, expect, vi } from "vitest"
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
import {
  attachContextualDrafts,
  hydrateContextualDrafts,
  resetContextualDraftsStore,
} from "@/lib/contextual/drafts-store"

// Capture target-side emits without touching IndexedDB / posthog. Every helper
// EditorTable imports must be present so the module resolves. `vi.hoisted`
// lets the spies exist before the hoisted `vi.mock` factory runs.
const { emitCellValidate, emitCellUnvalidate, emitTargetCellCommit, reviewContextualDraft } = vi.hoisted(() => ({
  emitCellValidate: vi.fn(() => Promise.resolve("validate-event")),
  emitCellUnvalidate: vi.fn(() => Promise.resolve("unvalidate-event")),
  emitTargetCellCommit: vi.fn(() => Promise.resolve("commit-event")),
  reviewContextualDraft: vi.fn(() => Promise.resolve()),
}))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellValidate,
  emitCellUnvalidate,
  emitTargetCellCommit,
  emitSourceCellCommit: vi.fn(() => Promise.resolve("source-event")),
  emitCellWaive: vi.fn(() => Promise.resolve("waive-event")),
  emitCellUnwaive: vi.fn(() => Promise.resolve("unwaive-event")),
}))
vi.mock("@/lib/contextual/transport", () => ({ reviewContextualDraft }))

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

function makeRows(
  id: string,
  targetValue = "bonjour",
  sourceMetadata?: Record<string, unknown>,
): CellRow[] {
  return [
    {
      cellId: id, side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-source`,
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
      ...(sourceMetadata ? { metadata: sourceMetadata } : {}),
    },
    {
      cellId: id, side: "target", value: targetValue, valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `${id}-target`,
      sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
    },
  ]
}

function makeStore(cellId: string, targetValue?: string, sourceMetadata?: Record<string, unknown>): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cellId, targetValue, sourceMetadata), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(
  activeLane: string,
  myScopes: MemberScope[] = [],
  targetValue?: string,
  sourceMetadata?: Record<string, unknown>,
) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{ myScopes }}>
        <EditorTable
          project={project}
          cellStore={makeStore("cell-1", targetValue, sourceMetadata)}
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

afterEach(() => {
  resetContextualDraftsStore()
})

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

  it("never renders a default-lane Autopilot draft inside a multilingual editor lane", () => {
    hydrateContextualDrafts(attachContextualDrafts(project.id, "file-1", ""), [
      { draftId: "draft-default", cellId: "cell-1", text: "Default-lane proposal" },
    ])

    renderTable("fr", [], "")

    expect(screen.queryByText("Default-lane proposal")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Use this translation" })).not.toBeInTheDocument()
    expect(emitTargetCellCommit).not.toHaveBeenCalled()
  })

  it("keeps and does not report a draft when the real editor enqueue fails", async () => {
    emitTargetCellCommit.mockRejectedValueOnce(new Error("Outbox unavailable"))
    reviewContextualDraft.mockClear()
    hydrateContextualDrafts(attachContextualDrafts(project.id, "file-1", ""), [
      { draftId: "draft-default", cellId: "cell-1", text: "Proposal must survive" },
    ])
    renderTable("", [], "")

    fireEvent.click(screen.getByRole("button", { name: "Use this translation" }))

    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Use this translation" })).not.toBeDisabled())
    expect(screen.getByText("Proposal must survive")).toBeInTheDocument()
    expect(screen.getByText("Outbox unavailable")).toBeInTheDocument()
    expect(reviewContextualDraft).not.toHaveBeenCalled()
  })

  it("keeps and does not report a draft when the IDML commit guard refuses it synchronously", async () => {
    emitTargetCellCommit.mockClear()
    reviewContextualDraft.mockClear()
    hydrateContextualDrafts(attachContextualDrafts(project.id, "file-1", ""), [
      { draftId: "draft-idml", cellId: "cell-1", text: "Plain text cannot replace IDML anchors" },
    ])
    renderTable("", [], "", { idml: null })

    fireEvent.click(screen.getByRole("button", { name: "Use this translation" }))

    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Use this translation" })).not.toBeDisabled())
    expect(screen.getByText("Plain text cannot replace IDML anchors")).toBeInTheDocument()
    expect(emitTargetCellCommit).not.toHaveBeenCalled()
    expect(reviewContextualDraft).not.toHaveBeenCalled()
  })
})
