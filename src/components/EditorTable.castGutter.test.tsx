/**
 * 2026-08-07: the character gutter — a voice circle at the far-left of each
 * SPEAKING row, only when the table renders under the stacked timeline
 * (castGutter). Wired through the real EditorTable + EditorActionsProvider so
 * a plumbing mistake (the live ttsSettings prop, the context handler) fails
 * here rather than silently rendering nothing.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider, type EditorActionsContextValue } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord, ProjectTtsSettings } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@/hooks/useMicPermission", () => ({
  useMicPermission: () => ({ micDenied: true }),
}))

// happy-dom has no layout engine — render every row (same stand-in as the
// editorActions suite).
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
          React.createElement(React.Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index })),
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
}

const TTS: ProjectTtsSettings = {
  voices: [
    { id: "v-narr", name: "Narrator", color: "#475569" },
    { id: "v-mary", name: "Mary", color: "#dd4444" },
    { id: "v-john", name: "John", color: "#4444dd" },
  ],
  defaultVoiceId: "v-narr",
  castAssignments: { "cell-cast": "v-mary", "cell-dangling": "v-deleted" },
}

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  type = "text",
  metadata?: Record<string, unknown>,
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type,
    canonicalRef: `GEN 1:${cellId}`,
    anchorCellId: null,
    eventId: `${cellId}-${side}`,
    sourceEventId: side === "target" ? `${cellId}-source` : null,
    lastEditor: null,
    lastEditAt: 1,
    validated: false,
    wordCount: 1,
    ...(metadata ? { metadata } : {}),
  } as CellRow
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
  store.replaceRows(
    [
      row("cell-cast", "source", "Mary's line", "text", { cast_name: "Mary" }),
      row("cell-cast", "target", "ligne"),
      row("cell-plain", "source", "an uncast line"),
      row("cell-plain", "target", ""),
      row("cell-dangling", "source", "assigned to a deleted voice"),
      row("cell-dangling", "target", ""),
      row("cell-heading", "source", "Section title", "paratext"),
      row("cell-heading", "target", "", "paratext"),
      row("cell-empty", "source", ""),
      row("cell-empty", "target", ""),
    ],
    { full: true, maxServerSeq: 1 },
  )
  return store
}

function renderTable(opts: {
  castGutter?: boolean
  actions?: Partial<EditorActionsContextValue>
} = {}) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={opts.actions ?? {}}>
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
          healthMap={new Map()}
          lineNumbersEnabled={false}
          cellLabelsEnabled={false}
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
          castGutter={opts.castGutter ?? true}
          ttsSettings={TTS}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

const rowEl = (cellId: string) => document.querySelector(`[data-cell-id="${cellId}"]`) as HTMLElement

describe("EditorTable — character gutter", () => {
  it("speaking rows get a circle; structure and empty rows get none", async () => {
    renderTable()
    await screen.findByText("Mary's line")
    expect(within(rowEl("cell-cast")).getByTestId("gutter-voice")).toBeInTheDocument()
    expect(within(rowEl("cell-plain")).getByTestId("gutter-voice")).toBeInTheDocument()
    expect(within(rowEl("cell-heading")).queryByTestId("gutter-voice")).toBeNull()
    expect(within(rowEl("cell-empty")).queryByTestId("gutter-voice")).toBeNull()
  })

  it("explicit casting is solid; unassigned AND dangling assignments read as fallback", async () => {
    renderTable()
    await screen.findByText("Mary's line")
    expect(within(rowEl("cell-cast")).getByTestId("gutter-voice")).toHaveAttribute("data-explicit", "true")
    expect(within(rowEl("cell-plain")).getByTestId("gutter-voice")).toHaveAttribute("data-explicit", "false")
    // castAssignments points at a voice deleted from the library — truthfully
    // faded, never solid-but-narrator.
    expect(within(rowEl("cell-dangling")).getByTestId("gutter-voice")).toHaveAttribute("data-explicit", "false")
  })

  it("the gutter track widens only when the gutter is on", async () => {
    const { unmount } = renderTable()
    await screen.findByText("Mary's line")
    expect(rowEl("cell-cast").querySelector("[data-grid-row]")!.className).toContain("grid-cols-[132px_1fr_1fr]")
    unmount()
    renderTable({ castGutter: false })
    await screen.findByText("Mary's line")
    expect(screen.queryAllByTestId("gutter-voice")).toHaveLength(0)
    expect(rowEl("cell-cast").querySelector("[data-grid-row]")!.className).toContain("grid-cols-[84px_1fr_1fr]")
  })

  it("picking a character reaches the context's PURE assignment handler with the cell", async () => {
    const onAssignCastVoice = vi.fn()
    renderTable({ actions: { onAssignCastVoice } })
    await screen.findByText("Mary's line")
    fireEvent.click(within(rowEl("cell-plain")).getByTestId("gutter-voice"))
    fireEvent.click(await screen.findByRole("button", { name: /John/ }))
    expect(onAssignCastVoice).toHaveBeenCalledTimes(1)
    const [cellArg, voiceId, opts] = onAssignCastVoice.mock.calls[0]
    expect(cellArg.id).toBe("cell-plain")
    expect(voiceId).toBe("v-john")
    expect(opts).toEqual({ applyToSpeaker: false })
  })

  it("the diarized speaker's apply-to-all footer rides along in the gutter popover", async () => {
    const onAssignCastVoice = vi.fn()
    renderTable({ actions: { onAssignCastVoice } })
    await screen.findByText("Mary's line")
    fireEvent.click(within(rowEl("cell-cast")).getByTestId("gutter-voice"))
    fireEvent.click(await screen.findByTestId("gutter-voice-all"))
    fireEvent.click(screen.getByRole("button", { name: /John/ }))
    expect(onAssignCastVoice).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cell-cast" }),
      "v-john",
      { applyToSpeaker: true },
    )
  })
})
