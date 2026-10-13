/**
 * AQU-1463: the editor goes read-only when the lane it is pointed at has been
 * archived, for every role, and says so in a banner naming the lane.
 *
 * The harness is the one `EditorTable.lane.test.tsx` uses — the real
 * EditorTable over a real CellStore with the target-side emits spied — because
 * the thing worth proving is that the lock reaches the WRITE PATH, not just
 * that a prop renders a banner. A project_lead is used throughout: the lock has
 * to outrank the role ladder, so proving it on a reader who could not edit
 * anyway would prove nothing.
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
vi.mock("@/lib/cell-telemetry", () => ({
  captureCellValidation: vi.fn(),
  captureAudioAction: vi.fn(),
}))

// happy-dom has no layout engine — render every row (same shim as the sibling
// EditorTable suites).
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

function projectAt(level: number): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    syncRole: { level, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
  }
}

function makeStore(project: ProjectRecord): CellStore {
  const rows: CellRow[] = [
    {
      cellId: "cell-1", side: "source", value: "hello", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-source",
      sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    },
    {
      cellId: "cell-1", side: "target", value: "bonjour", valueHtml: null, type: "text",
      canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "cell-1-target",
      sourceEventId: "cell-1-source", lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 1,
    },
  ]
  const store = new CellStore()
  store.setRuntime({
    projectId: project.id,
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(
  archivedLaneLabel: string | null,
  level: number = ROLE.PROJECT_LEAD,
  onLaneChange?: (lane: string) => void,
) {
  const project = projectAt(level)
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{ myScopes: [] }}>
        <EditorTable
          project={project}
          cellStore={makeStore(project)}
          username="tester"
          activeLane="es"
          lanes={["", "es"]}
          archivedLanes={archivedLaneLabel ? ["es"] : []}
          archivedLaneLabel={archivedLaneLabel}
          onLaneChange={onLaneChange}
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

describe("EditorTable — archived lane read-only banner (AQU-1463)", () => {
  it("banners the archived lane by name", async () => {
    renderTable("Spanish")
    const banner = await screen.findByTestId("lane-archived-banner")
    expect(banner).toHaveTextContent("Spanish")
    expect(banner).toHaveTextContent(/read-only/i)
  })

  it("promises reading, searching, exporting and commenting are still available", async () => {
    renderTable("Spanish")
    const banner = await screen.findByTestId("lane-archived-banner")
    for (const kept of [/read/i, /search/i, /export/i, /comment/i]) {
      expect(banner).toHaveTextContent(kept)
    }
  })

  it("shows no banner at all while the lane is active", () => {
    renderTable(null)
    expect(screen.queryByTestId("lane-archived-banner")).not.toBeInTheDocument()
    expect(screen.queryByTestId("role-read-only-banner")).not.toBeInTheDocument()
  })

  it("banners the archive rather than the role, so a reviewer is not told they can validate", async () => {
    renderTable("Spanish", ROLE.REVIEWER)
    const banner = await screen.findByTestId("lane-archived-banner")
    expect(banner).not.toHaveTextContent(/reviewer/i)
    expect(screen.queryByTestId("role-read-only-banner")).not.toBeInTheDocument()
  })

  it("still blames the role when the lane is active", async () => {
    renderTable(null, ROLE.REVIEWER)
    expect(await screen.findByTestId("role-read-only-banner")).toHaveTextContent(/reviewer/i)
    expect(screen.queryByTestId("lane-archived-banner")).not.toBeInTheDocument()
  })
})

describe("EditorTable — an archived lane takes no writes (AQU-1463)", () => {
  it("withdraws the validation affordance from a project lead", async () => {
    emitCellValidate.mockClear()
    renderTable("Spanish")
    // The banner proves the table rendered, so a missing control is the lock
    // rather than a row that never arrived.
    await screen.findByTestId("lane-archived-banner")
    expect(screen.queryByRole("button", { name: /Click to validate/ })).not.toBeInTheDocument()
    expect(emitCellValidate).not.toHaveBeenCalled()
  })

  it("leaves that same affordance live for the same lead on an active lane", async () => {
    emitCellValidate.mockClear()
    renderTable(null)
    const button = await screen.findByRole("button", { name: /Click to validate/ })
    fireEvent.click(button)
    expect(emitCellValidate).toHaveBeenCalledTimes(1)
    expect(emitCellValidate).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: "cell-1", targetLang: "es" }),
    )
  })

  it("emits nothing at all from an archived lane", async () => {
    emitCellValidate.mockClear()
    emitCellUnvalidate.mockClear()
    emitTargetCellCommit.mockClear()
    renderTable("Spanish")
    await screen.findByTestId("lane-archived-banner")
    // Clicking anything the frozen table still renders must not reach the wire.
    for (const button of screen.queryAllByRole("button")) fireEvent.click(button)
    expect(emitCellValidate).not.toHaveBeenCalled()
    expect(emitCellUnvalidate).not.toHaveBeenCalled()
    expect(emitTargetCellCommit).not.toHaveBeenCalled()
  })

  it("renders the target text, so the lane is readable while frozen", async () => {
    renderTable("Spanish")
    await screen.findByTestId("lane-archived-banner")
    expect(screen.getByText("bonjour")).toBeInTheDocument()
    expect(screen.getByText("hello")).toBeInTheDocument()
  })
})

describe("EditorTable — the way out of a frozen lane stays open (AQU-1463)", () => {
  it("keeps the lane switcher live, so the member is not trapped read-only", async () => {
    // The lock covers the lane, not the project: a member whose lane was
    // archived has to be able to reach their other lanes. Freezing the
    // switcher along with the writes would strand them.
    // MAINTAINER because `canSwitchLanes` is the switcher's floor (AQU-608) —
    // and it is the stronger case: the lock freezes a maintainer too, so this
    // proves the same reader is frozen AND still able to leave.
    const onLaneChange = vi.fn()
    renderTable("Spanish", ROLE.MAINTAINER, onLaneChange)
    await screen.findByTestId("lane-archived-banner")
    const switcher = screen.getByTestId("lane-switcher")
    expect(switcher).not.toBeDisabled()
    expect(switcher).toHaveAttribute("data-active-lane", "es")
  })
})
