/**
 * AQU-1571: the editor row's text check is blocked up front wherever the
 * server would refuse the vote, so a click never sends one and the red
 * "1 failed" banner never appears.
 *
 * Three project rules, all enforced by sync-worker route.ts on `cell.validate`:
 * "Allow self-validation" off on a line whose latest change in THIS lane is
 * the viewer's, the minimum role to validate, and the named-validator list.
 * The same rules stop auto-validate-on-edit queueing a vote they would refuse.
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
import {
  attachContextualDrafts,
  hydrateContextualDrafts,
  resetContextualDraftsStore,
} from "@/lib/contextual/drafts-store"
import { STALL_WATCHDOG_MS } from "@/test-utils/timeouts"

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

const OWN_EDIT = "You made the latest change to this text, so someone else must validate it"

function projectWith(over: Partial<ProjectRecord> = {}, level: number = ROLE.CONTRIBUTOR): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    syncRole: { level, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
    ...over,
  }
}

function target(value: string, lastEditor: string | null, targetLang?: string): CellRow {
  return {
    cellId: "cell-1", side: "target", value, valueHtml: null, type: "text",
    canonicalRef: "GEN 1:1", anchorCellId: null, eventId: `cell-1-target-${targetLang ?? ""}`,
    sourceEventId: "cell-1-source", lastEditor, lastEditAt: 2, validated: false, wordCount: 1,
    ...(targetLang !== undefined ? { targetLang } : {}),
  }
}

function makeStore(targets: CellRow[], lane = ""): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: "proj-1", fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map(), lane })
  store.replaceRows([
    {
      cellId: "cell-1", side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-source",
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    ...targets,
  ], { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(project: ProjectRecord, store: CellStore, activeLane = "") {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={store}
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
          onOptimisticEdit={(cellId, patch) => store.applyOptimisticTargetEdit(cellId, patch)}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

async function tooltipOf(button: HTMLElement) {
  fireEvent.mouseEnter(button)
  fireEvent.pointerEnter(button)
  fireEvent.focus(button)
  return screen.findByRole("tooltip")
}

afterEach(() => {
  resetContextualDraftsStore()
  emitCellValidate.mockClear()
  emitTargetCellCommit.mockClear()
})

describe("EditorTable — text validation blocked where the server would refuse it", () => {
  it("greys the reader's own latest change and sends nothing on a click", async () => {
    renderTable(projectWith({ allowSelfValidation: false }), makeStore([target("bonjour", "tester")]))
    const button = await screen.findByRole("button", { name: /^Not validated — .*\.$/ })
    expect(button).toHaveAttribute("aria-disabled", "true")
    expect(await tooltipOf(button)).toHaveTextContent(OWN_EDIT)
    fireEvent.click(button)
    expect(emitCellValidate).not.toHaveBeenCalled()
  })

  it("leaves somebody else's change clickable", async () => {
    renderTable(projectWith({ allowSelfValidation: false }), makeStore([target("bonjour", "alice")]))
    fireEvent.click(await screen.findByRole("button", { name: /Click to validate/ }))
    expect(emitCellValidate).toHaveBeenCalledTimes(1)
  })

  it("leaves the reader's own change clickable when the project allows it", async () => {
    renderTable(projectWith({ allowSelfValidation: true }), makeStore([target("bonjour", "tester")]))
    fireEvent.click(await screen.findByRole("button", { name: /Click to validate/ }))
    expect(emitCellValidate).toHaveBeenCalledTimes(1)
  })

  // Old imported rows carry no editor; unknown is never the reader.
  it("never blocks a line whose last editor is unknown", async () => {
    renderTable(projectWith({ allowSelfValidation: false }), makeStore([target("bonjour", null)]))
    fireEvent.click(await screen.findByRole("button", { name: /Click to validate/ }))
    expect(emitCellValidate).toHaveBeenCalledTimes(1)
  })

  // The server judges the lane being validated: a line the reader wrote in
  // the default lane but Alice wrote in French is theirs only in the default.
  it("judges the lane being looked at", async () => {
    const rows = [target("bonjour", "tester"), target("salut", "alice", "fr")]
    const project = projectWith({ allowSelfValidation: false })

    const french = renderTable(project, makeStore(rows, "fr"), "fr")
    fireEvent.click(await screen.findByRole("button", { name: /Click to validate/ }))
    expect(emitCellValidate).toHaveBeenCalledWith(expect.objectContaining({ targetLang: "fr" }))
    french.unmount()
    emitCellValidate.mockClear()

    renderTable(project, makeStore(rows, ""), "")
    const button = await screen.findByRole("button", { name: /^Not validated — .*\.$/ })
    expect(button).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(button)
    expect(emitCellValidate).not.toHaveBeenCalled()
  })

  it("reads as unavailable under a minimum role above the reader's", async () => {
    renderTable(projectWith({ validationRoleFloor: "project_lead" }, ROLE.CONTRIBUTOR), makeStore([target("bonjour", "alice")]))
    const button = await screen.findByRole("button", { name: /^Not validated — .*\.$/ })
    expect(button).toHaveAttribute("aria-disabled", "true")
    expect(await tooltipOf(button)).toHaveTextContent("Text validation unavailable")
    fireEvent.click(button)
    expect(emitCellValidate).not.toHaveBeenCalled()
  })

  it("reads as unavailable to a reader left off the named-validator list", async () => {
    renderTable(projectWith({ validationNamedUsers: ["alice"] }), makeStore([target("bonjour", "alice")]))
    const button = await screen.findByRole("button", { name: /^Not validated — .*\.$/ })
    expect(await tooltipOf(button)).toHaveTextContent("Text validation unavailable")
    fireEvent.click(button)
    expect(emitCellValidate).not.toHaveBeenCalled()
  })

  // The block starts the moment the reader edits, before the server hears of
  // it: the store stamps them on the row with the optimistic edit.
  it("blocks the line as soon as the reader's own edit lands, and queues no vote for it", async () => {
    hydrateContextualDrafts(attachContextualDrafts("proj-1", "file-1", ""), [
      { draftId: "draft-1", cellId: "cell-1", text: "Bonjour le monde" },
    ])
    renderTable(projectWith({ allowSelfValidation: false }), makeStore([target("", "alice")]))
    fireEvent.click(await screen.findByRole("button", { name: "Use this translation" }))
    await vi.waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(1), { timeout: STALL_WATCHDOG_MS })
    const button = await screen.findByRole("button", { name: /^Not validated — .*\.$/ })
    expect(button).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(button)
    expect(emitCellValidate).not.toHaveBeenCalled()
  })

  // AQU-1571: auto-validate-on-edit asked only the role ladder, so a
  // contributor under a "project lead and above" floor queued a vote the
  // server refused — a red banner on an ordinary edit.
  it("does not auto-validate an edit the minimum role would refuse", async () => {
    hydrateContextualDrafts(attachContextualDrafts("proj-1", "file-1", ""), [
      { draftId: "draft-1", cellId: "cell-1", text: "Bonjour le monde" },
    ])
    renderTable(projectWith({ validationRoleFloor: "project_lead" }, ROLE.CONTRIBUTOR), makeStore([target("", null)]))
    fireEvent.click(await screen.findByRole("button", { name: "Use this translation" }))
    await vi.waitFor(() => expect(emitTargetCellCommit).toHaveBeenCalledTimes(1), { timeout: STALL_WATCHDOG_MS })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(emitCellValidate).not.toHaveBeenCalled()
  })

  it("still auto-validates an edit when the reader clears the minimum role", async () => {
    hydrateContextualDrafts(attachContextualDrafts("proj-1", "file-1", ""), [
      { draftId: "draft-1", cellId: "cell-1", text: "Bonjour le monde" },
    ])
    renderTable(projectWith({ validationRoleFloor: "project_lead" }, ROLE.PROJECT_LEAD), makeStore([target("", null)]))
    fireEvent.click(await screen.findByRole("button", { name: "Use this translation" }))
    await vi.waitFor(() => expect(emitCellValidate).toHaveBeenCalledTimes(1), { timeout: STALL_WATCHDOG_MS })
  })
})

// Walk 10-02: bob, a reviewer left off the named-validator list, read "you can
// validate and comment" above a column of checks that each said he could not.
describe("EditorTable — the reviewer banner agrees with the checks", () => {
  const CAN = "Viewing as reviewer — you can validate and comment"
  const CANNOT = "Viewing as reviewer. You can comment, but this project does not let you validate text."

  it("keeps the usual reviewer banner where the reviewer may validate", async () => {
    renderTable(projectWith({}, ROLE.REVIEWER), makeStore([target("bonjour", "alice")]))
    expect(await screen.findByText(CAN)).toBeInTheDocument()
  })

  it("says the reviewer cannot validate text when the named list leaves them out", async () => {
    renderTable(projectWith({ validationNamedUsers: ["alice"] }, ROLE.REVIEWER), makeStore([target("bonjour", "alice")]))
    expect(await screen.findByText(CANNOT)).toBeInTheDocument()
    expect(screen.queryByText(CAN)).not.toBeInTheDocument()
  })

  it("says the same under a minimum role above reviewer", async () => {
    renderTable(projectWith({ validationRoleFloor: "project_lead" }, ROLE.REVIEWER), makeStore([target("bonjour", "alice")]))
    expect(await screen.findByText(CANNOT)).toBeInTheDocument()
  })

  it("shows no banner for a contributor, whatever the validation rules", async () => {
    renderTable(projectWith({ validationNamedUsers: ["alice"] }, ROLE.CONTRIBUTOR), makeStore([target("bonjour", "alice")]))
    await screen.findByRole("button", { name: /^Not validated — .*\.$/ })
    expect(screen.queryByText(CANNOT)).not.toBeInTheDocument()
  })
})
