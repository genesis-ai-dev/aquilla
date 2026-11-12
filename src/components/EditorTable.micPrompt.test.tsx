/**
 * AQU-1758 (Sam): the browser's microphone pop-up appears only when the
 * recording window opens, "in every scenario ever". The Media table reads the
 * permission to mark a blocked mic — and must never ASK for it, which is what
 * getUserMedia does when the state is "prompt".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider, type EditorActionsContextValue } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord, ProjectTtsSettings } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"

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
      row("cell-section", "source", "The Creation", "heading"),
      row("cell-section", "target", "The Creation", "heading"),
      row("cell-empty", "source", ""),
      row("cell-empty", "target", ""),
      // A transcribed media cell whose stored `value` is the import filename:
      // the second row the old text rule quietly dropped. (It dropped this one
      // even though the rule appeared to fall back to `transcription` — the
      // `??` never fired, because cell.original is always a string.)
      { ...row("cell-transcribed", "source", "episode-03.mp3"), transcription: "spoken words" } as CellRow,
      row("cell-transcribed", "target", ""),
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


const query = vi.fn(async () => ({ state: "prompt" }) as PermissionStatus)
const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream)
const enumerateDevices = vi.fn(async () => [] as MediaDeviceInfo[])

beforeEach(() => {
  query.mockClear()
  getUserMedia.mockClear()
  enumerateDevices.mockClear()
  vi.stubGlobal("navigator", {
    ...navigator,
    permissions: { query },
    mediaDevices: { getUserMedia, enumerateDevices },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("EditorTable in Media — the microphone (AQU-1758)", () => {
  it("reads the permission, and never asks for the microphone, when the state is prompt", async () => {
    renderTable()
    await screen.findByText("Mary's line")
    await vi.waitFor(() => expect(query).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(enumerateDevices).not.toHaveBeenCalled()
  })
})
