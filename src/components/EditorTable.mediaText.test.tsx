/**
 * AQU-646: the TEXT lens of a time-ordered (imported audio) file shows media
 * sections as ordinary translatable rows — transcript as the source text once
 * transcribed, the filename placeholder before that. Locks in the lens filter
 * change (getCellIdsForLens) + EditorTable's media-aware source rendering.
 */

import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { ROLE } from "@/lib/frontier/roles"

// AQU-847 needs the pencil visible: the source-edit affordance is gated on a
// resolved (unlinked) DCS cursor, and the un-mocked hook leaves it loading.
vi.mock("@/hooks/useDcsUpstreamCursor", () => ({
  useDcsUpstreamCursor: () => ({ cursor: null, loading: false }),
}))

vi.mock("@/lib/sync/events-emit", () => ({
  emitCellValidate: vi.fn(() => Promise.resolve("validate-event")),
  emitCellUnvalidate: vi.fn(() => Promise.resolve("unvalidate-event")),
  emitTargetCellCommit: vi.fn(() => Promise.resolve("commit-event")),
  emitSourceCellCommit: vi.fn(() => Promise.resolve("source-event")),
  emitCellWaive: vi.fn(() => Promise.resolve("waive-event")),
  emitCellUnwaive: vi.fn(() => Promise.resolve("unwaive-event")),
}))

// happy-dom has no layout engine — render every row (same shim as the other
// EditorTable tests).
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
  syncRole: { level: ROLE.PROJECT_LEAD, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
}

function mediaRow(cellId: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId, side: "source", value: "episode.mp3", valueHtml: null, type: "text",
    canonicalRef: null, anchorCellId: null, eventId: `${cellId}-source`,
    sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    medium: "media",
    ...over,
  } as CellRow
}

function makeStore(rows: CellRow[]): CellStore {
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

function renderTable(store: CellStore) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{ myScopes: [] }}>
        <EditorTable
          project={project}
          cellStore={store}
          username="tester"
          activeLane=""
          orderedBy="time"
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

describe("EditorTable — media sections in the TEXT lens (AQU-646)", () => {
  it("a transcribed section renders its transcript as the source text", async () => {
    renderTable(makeStore([
      mediaRow("m1", { startMs: 0, endMs: 5_000, transcription: "in the beginning was the word" }),
    ]))
    expect(await screen.findByText("in the beginning was the word")).toBeInTheDocument()
    expect(screen.queryByText("No text segments in this file")).toBeNull()
  })

  it("an untranscribed section shows the filename placeholder, not an empty view", async () => {
    renderTable(makeStore([mediaRow("m2", { startMs: 0, endMs: 5_000 })]))
    expect(await screen.findByText("episode.mp3")).toBeInTheDocument()
    expect(screen.queryByText("No text segments in this file")).toBeNull()
  })
})

describe("EditorTable — correcting a media section's transcript (AQU-847)", () => {
  it("the pencil opens the editor on the TRANSCRIPT, not the file title", async () => {
    renderTable(makeStore([
      mediaRow("m3", { startMs: 0, endMs: 5_000, transcription: "in the beginning was the word" }),
    ]))
    fireEvent.click(await screen.findByRole("button", { name: "Edit source text" }))
    const editor = await screen.findByRole("textbox", { name: "Edit source text" })
    expect(editor.textContent).toBe("in the beginning was the word")
    expect(editor.textContent).not.toContain("episode.mp3")
  })

  it("a filename valueHtml never shadows the transcript in the read surface", async () => {
    // The shape a pre-fix commit left behind: `value_html` populated from the
    // file title. The HTML branch used to win outright and pin the file title
    // over the transcript forever.
    renderTable(makeStore([
      mediaRow("m4", {
        startMs: 0,
        endMs: 5_000,
        valueHtml: "<p>episode.mp3</p>",
        transcription: "in the beginning was the word",
      }),
    ]))
    expect(await screen.findByText("in the beginning was the word")).toBeInTheDocument()
    expect(screen.queryByText("episode.mp3")).toBeNull()
  })
})
