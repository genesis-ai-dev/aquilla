/**
 * AQU-608: the editor-header TARGET-tag lane switcher is a maintainer-and-above
 * affordance. This test renders the real EditorTable with more than one lane and
 * an `onLaneChange` handler, and proves:
 *   - a maintainer (600) sees the interactive dropdown (`lane-switcher`);
 *   - a contributor (400) does NOT — the tag falls back to a static pill that
 *     still names the target language, so translators keep to their lane.
 * The dropdown UI itself landed with AQU-602; this locks in the role gate.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
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

// happy-dom has no layout engine — replace the virtualized list with a trivial
// "render every row" stand-in (same shim as EditorTable.lane.test).
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

function makeProject(level: number, targetLanguage = "fr"): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage,
    createdAt: "2026-01-01T00:00:00Z",
    files: [],
    members: [],
    syncRole: { level, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
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

function makeStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: "proj-1",
    fileId: "file-1",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows("cell-1"), { full: true, maxServerSeq: 1 })
  return store
}

function renderTable(level: number, targetLanguage = "fr") {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={makeProject(level, targetLanguage)}
          cellStore={makeStore()}
          username="tester"
          activeLane=""
          lanes={["", "es"]}
          onLaneChange={() => {}}
          defaultLaneLabel="fr"
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

describe("EditorTable — lane switcher is maintainer-gated (AQU-608)", () => {
  it("shows the interactive dropdown for a maintainer", async () => {
    renderTable(ROLE.MAINTAINER)
    expect(await screen.findByTestId("lane-switcher")).toBeInTheDocument()
  })

  it("hides the switcher for a contributor, leaving a static target-language pill", async () => {
    renderTable(ROLE.CONTRIBUTOR)
    // The row renders (proves the header mounted) but no lane switcher exists…
    await screen.findByText("bonjour")
    expect(screen.queryByTestId("lane-switcher")).not.toBeInTheDocument()
    // …and the target language is still shown as a plain pill.
    expect(screen.getByText("fr")).toBeInTheDocument()
  })

  // AQU-583: with extra lanes registered but no default target language set, the
  // switcher must still be reachable so the named lanes aren't stranded — the
  // trigger prompts to set the default rather than showing a blank pill.
  it("shows the switcher for a maintainer even with no default target language", async () => {
    renderTable(ROLE.MAINTAINER, "")
    const switcher = await screen.findByTestId("lane-switcher")
    expect(switcher).toBeInTheDocument()
    expect(switcher).toHaveTextContent("Set target language")
  })
})
