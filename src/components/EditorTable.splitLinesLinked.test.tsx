/**
 * AQU-2426 (review, Nov 9): a recording added by web address is streamed from
 * where it lives, so it can't be read here and can't be split. Its line's ⋯
 * menu had no Split into lines… at all, at any length, with nothing saying
 * why. The entry is now there, greyed, with the reason under it.
 *
 * A recording stored in the project keeps its working entry, and someone who
 * may not split lines still sees no entry (the reason is about the recording,
 * not about them).
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { ROLE } from "@/lib/sync/role-policy"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/hooks/useMicPermission", () => ({ useMicPermission: () => ({ micDenied: true }) }))
vi.mock("@/hooks/useDcsUpstreamCursor", () => ({ useDcsUpstreamCursor: () => ({ cursor: null, loading: false }) }))

// The line's recording, as the file's recordings read hands it to the rows.
const recordings = vi.hoisted(() => ({ byCellId: new Map<string, unknown>() }))
vi.mock("@/hooks/useFileAudioAttachments", async (orig) => ({
  ...(await orig<typeof import("@/hooks/useFileAudioAttachments")>()),
  useFileAudioAttachments: () => ({ byCellId: recordings.byCellId, isLoading: false, hasLoaded: true, revalidate: () => {} }),
}))

// happy-dom has no layout engine — render every row.
vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")
  return {
    LegendList: React.forwardRef(function MockLegendList({
      data, renderItem, keyExtractor,
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
      return React.createElement("div", null, data.map((item, index) =>
        React.createElement(React.Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index }))))
    }),
  }
})

const FILE = "file-1"
const CLIP = `audio-${FILE}-1793000000000-abc`

const baseProject: ProjectRecord = {
  id: "proj-1", name: "Test Project", sourceLanguage: "en", targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z", files: [], members: [],
}
const project = (level: number): ProjectRecord => ({ ...baseProject, syncRole: { level } }) as ProjectRecord

function row(side: "source" | "target", value: string): CellRow {
  return {
    cellId: "line-a", side, value, valueHtml: null, type: "text", canonicalRef: null, anchorCellId: null,
    eventId: `line-a-${side}`, sourceEventId: side === "target" ? "line-a-source" : null,
    lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1,
    medium: "media", startMs: 0, endMs: 3_134_000,
  } as CellRow
}

type Actions = Parameters<typeof EditorActionsProvider>[0]["value"]

function renderLine(url: string, level: number, splitLines: NonNullable<Actions["splitLines"]>) {
  recordings.byCellId = new Map<string, unknown>([["line-a", {
    attachments: { [CLIP]: { url, durationMs: 3_134_000, role: "source", slot: "recording" } },
    selectedAudioId: CLIP, selectedBySlot: { recording: CLIP }, selectedGeneratedVoiceAudioId: null, audioTimings: {},
  }]])
  const store = new CellStore()
  store.setRuntime({ projectId: "proj-1", fileId: FILE, username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows([row("source", "sermon.mp3"), row("target", "")], { full: true, maxServerSeq: 1 })
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <EditorActionsProvider value={{ splitLines }}>
        <EditorTable
          project={project(level)} cellStore={store} username="tester"
          isCompletionConfigured={false} isCompletionAvailable={false}
          completing={new Map()} examples={new Map()} errors={new Map()} previews={new Map()}
          onCompleteSingle={() => {}} onCompleteBatch={() => {}} healthMap={new Map()}
          lineNumbersEnabled={false} cellLabelsEnabled={false} sourceTextDirection="ltr" targetTextDirection="ltr"
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

const rowEl = () => document.querySelector('[data-cell-id="line-a"]') as HTMLElement
const openMenu = () => fireEvent.click(within(rowEl()).getByTestId("cell-menu-line-a"))
const actions = (canSplit: boolean) => ({
  canSplit, block: null, onSplitIntoLines: vi.fn<NonNullable<Actions["splitLines"]>["onSplitIntoLines"]>(), onSplitAtPauses: vi.fn(),
})

describe("Text view: Split into lines… on a recording added by web address", () => {
  it("is there, greyed, and says why", async () => {
    const splitLines = actions(true)
    renderLine("https://cdn.example.com/sermon.mp3", ROLE.MAINTAINER, splitLines)
    await screen.findByTestId("cell-menu-line-a")
    openMenu()
    const item = await screen.findByTestId("cell-menu-split-lines")
    expect(item).toHaveAttribute("data-disabled")
    expect(screen.getByTestId("cell-menu-split-lines-reason"))
      .toHaveTextContent("This recording isn't stored in the project, so it can't be split here.")
    fireEvent.click(item)
    expect(splitLines.onSplitIntoLines).not.toHaveBeenCalled()
  })

  it("a recording stored in the project keeps its working entry", async () => {
    const splitLines = actions(true)
    renderLine("frontier-audio://proj-1/file-1/clip.mp3", ROLE.MAINTAINER, splitLines)
    await screen.findByTestId("cell-menu-line-a")
    openMenu()
    const item = await screen.findByTestId("cell-menu-split-lines")
    expect(item).not.toHaveAttribute("data-disabled")
    expect(screen.queryByTestId("cell-menu-split-lines-reason")).toBeNull()
    fireEvent.click(item)
    expect(splitLines.onSplitIntoLines).toHaveBeenCalledWith("line-a", "pauses", expect.anything())
  })

  it("someone who may not split lines gets no entry, greyed or otherwise", async () => {
    renderLine("https://cdn.example.com/sermon.mp3", ROLE.MAINTAINER, actions(false))
    await screen.findByTestId("cell-menu-line-a")
    openMenu()
    await screen.findByTestId("cell-menu-edit-source")
    expect(screen.queryByTestId("cell-menu-split-lines")).toBeNull()
  })
})
