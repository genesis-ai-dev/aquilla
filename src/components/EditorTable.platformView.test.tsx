/**
 * AQU-2003: a platform admin who has not entered the step-up code opens a
 * foreign project at Viewer (sync token `source: "platform"`). The editor says
 * so and offers the code prompt. Same harness as EditorTable.archivedLane.test.tsx.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
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
  clearElevationRequired,
  getElevationWaitingOn,
  notifyElevationGranted,
  onElevationGranted,
} from "@/lib/errors/elevation-required-signal"

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

function projectAt(level: number, source: "server" | "platform" = "platform"): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    syncRole: { level, name: "test", source, fetchedAt: "2026-01-01T00:00:00Z" },
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

function renderTable(level: number, source: "server" | "platform" = "platform", archivedLaneLabel: string | null = null) {
  const project = projectAt(level, source)
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

afterEach(() => clearElevationRequired())

describe("EditorTable — platform admin read-only banner (AQU-2003)", () => {
  it("tells an un-elevated platform admin they are viewing, and offers the code", async () => {
    renderTable(ROLE.VIEWER)
    const banner = await screen.findByTestId("role-read-only-banner")
    expect(banner).toHaveTextContent("You're viewing this project as a platform admin. Changes need the admin code.")
    expect(screen.getByTestId("platform-view-enter-code")).toHaveTextContent("Enter code to edit")
  })

  it("asks for step-up on this project when the button is pressed", async () => {
    const granted = vi.fn()
    const off = onElevationGranted(granted)
    renderTable(ROLE.VIEWER)
    fireEvent.click(await screen.findByTestId("platform-view-enter-code"))
    expect(getElevationWaitingOn()).toBe("sync-token")
    // The grant names this project, which is what remounts the workspace.
    notifyElevationGranted()
    expect(granted).toHaveBeenCalledTimes(1)
    expect([...granted.mock.calls[0][0]]).toEqual(["proj-1"])
    off()
  })

  it("keeps the generic viewer banner, with no button, for a real viewer", async () => {
    renderTable(ROLE.VIEWER, "server")
    expect(await screen.findByTestId("role-read-only-banner")).toHaveTextContent(/viewer/i)
    expect(screen.queryByTestId("platform-view-enter-code")).not.toBeInTheDocument()
  })

  it("shows no banner for an elevated platform admin", async () => {
    renderTable(ROLE.OWNER)
    await screen.findByText("bonjour")
    expect(screen.queryByTestId("role-read-only-banner")).not.toBeInTheDocument()
    expect(screen.queryByTestId("platform-view-enter-code")).not.toBeInTheDocument()
  })

  it("lets an archived lane keep its own banner", async () => {
    renderTable(ROLE.VIEWER, "platform", "Spanish")
    expect(await screen.findByTestId("lane-archived-banner")).toHaveTextContent("Spanish")
    expect(screen.queryByTestId("platform-view-enter-code")).not.toBeInTheDocument()
  })
})
