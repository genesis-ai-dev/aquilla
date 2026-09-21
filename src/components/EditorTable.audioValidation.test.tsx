/**
 * AQU-490, after Sam's first manual pass (2026-09-21):
 *
 * 1. With audio validation on for a file, EVERY row draws the control — a
 *    line with no recording gets a placeholder mic, not a gap. The column reads
 *    as three states (not recorded / recorded / validated) rather than two.
 * 2. The Recording tab lists a take that lives on an ADDED track. It did not,
 *    so a line whose only recording sat off the default track opened to an
 *    empty panel — the attention dot said audio, the panel said nothing.
 *
 * Real EditorTable, real rows, mocked list virtualiser (happy-dom has no
 * layout) and a mocked per-file audio read so the takes can be shaped exactly.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"

vi.mock("@/hooks/useMicPermission", () => ({ useMicPermission: () => ({ micDenied: true }) }))
vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")
  return {
    LegendList: React.forwardRef(function MockLegendList(
      { data, renderItem, keyExtractor }: { data: string[]; renderItem: (p: { item: string; index: number }) => ReactNode; keyExtractor?: (i: string, n: number) => string },
      ref,
    ) {
      React.useImperativeHandle(ref, () => ({
        getState: () => ({ scroll: 0, positionAtIndex: (i: number) => i * 140, sizeAtIndex: () => 140 }),
        scrollToIndex: async () => undefined, scrollToOffset: async () => undefined,
      }))
      return React.createElement("div", null, data.map((item, index) =>
        React.createElement(React.Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index }))))
    }),
  }
})
// The takes, shaped per test. Everything else in that module stays real.
const audioState = vi.hoisted(() => ({ byCellId: new Map<string, CellAudioEntry>() }))
vi.mock("@/hooks/useFileAudioAttachments", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFileAudioAttachments: () => ({ byCellId: audioState.byCellId, isLoading: false, revalidate: vi.fn() }),
}))
// The take block's audio controller reaches for AudioContext and fetch; a
// stub keeps the block mounted without a media pipeline behind it.
vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "ready", error: null, isPlaying: false, currentTime: 0, duration: 3,
    peaks: null, peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))

const project = {
  id: "proj-1", name: "Test Project", sourceLanguage: "en", targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z", files: [], members: [],
  showAudioValidationInTextView: true,
} as unknown as ProjectRecord

function rows(id: string, ref: string): CellRow[] {
  const base = { type: "text", canonicalRef: ref, anchorCellId: null, lastEditAt: 1, validated: false, wordCount: 1, valueHtml: null }
  return [
    { ...base, cellId: id, side: "source", value: "hello", eventId: `${id}-s`, sourceEventId: null, lastEditor: null },
    { ...base, cellId: id, side: "target", value: `bonjour ${id}`, eventId: `${id}-t`, sourceEventId: `${id}-s`, lastEditor: "tester", lastEditAt: 2 },
  ] as CellRow[]
}

function store(): CellStore {
  const s = new CellStore()
  s.setRuntime({ projectId: project.id, fileId: "file-1", username: "tester", requiredValidations: 1, auditStats: new Map() })
  s.replaceRows([...rows("cell-1", "GEN 1:1"), ...rows("cell-2", "GEN 1:2")], { full: true, maxServerSeq: 1 })
  return s
}

const take = (audioId: string, slot: string, label: string | null = null) => ({
  audioId, url: `frontier-audio://${audioId}.webm`, slot, mimeType: "audio/webm", voiceId: null,
  referenceAudioId: null, durationMs: 1000, label, trimStartMs: null, trimEndMs: null,
  role: "dub" as const, validatorCount: 0, validators: [], recordedBy: "tester",
})

function entry(takes: ReturnType<typeof take>[]): CellAudioEntry {
  const selectedBySlot = Object.fromEntries(takes.map((t) => [t.slot, t.audioId]))
  return {
    attachments: Object.fromEntries(takes.map((t) => [t.audioId, t])),
    selectedBySlot,
    selectedAudioId: selectedBySlot.recording ?? null,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  } as unknown as CellAudioEntry
}

// The same prop set the editorActions harness mounts with — every map the
// table reads unconditionally has to be present.
function tableProps(p: ProjectRecord) {
  return {
    project: p, cellStore: store(), username: "tester",
    isCompletionConfigured: false, isCompletionAvailable: false,
    completing: new Map<string, string>(), examples: new Map(), errors: new Map(), previews: new Map(),
    onCompleteSingle: () => {}, onCompleteBatch: () => {},
    healthMap: new Map<string, number>(),
    lineNumbersEnabled: false, cellLabelsEnabled: false,
    sourceTextDirection: "ltr" as const, targetTextDirection: "ltr" as const,
  }
}

function renderTable() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <EditorActionsProvider value={{ onOpenRecording: vi.fn() }}>
          <EditorTable {...tableProps(project)} />
        </EditorActionsProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const rowOf = async (target: string) => (await screen.findByText(target)).closest("[data-grid-row]") as HTMLElement

describe("EditorTable — audio validation across the whole gutter", () => {
  it("draws a placeholder on the line with no recording and a real control on the line with one", async () => {
    audioState.byCellId = new Map([["cell-1", entry([take("t1", "recording")])]])
    renderTable()
    const withTake = await rowOf("bonjour cell-1")
    const without = await rowOf("bonjour cell-2")
    expect(within(withTake).getByTestId("audio-validation-button")).toBeInTheDocument()
    expect(within(without).queryByTestId("audio-validation-button")).toBeNull()
    expect(within(without).getByTestId("audio-validation-empty")).toHaveAccessibleName(/nothing recorded on this line/i)
  })

  // The derived switch looks at the FILE. A project with no stamp and no audio
  // shows nothing at all — no placeholders, no controls — which is the "off
  // until there is audio" half of Sam's ruling.
  it("draws nothing anywhere when the file has no audio and the project has no stamp", async () => {
    audioState.byCellId = new Map()
    render(
      <MemoryRouter><QueryClientProvider client={new QueryClient()}><EditorActionsProvider value={{}}>
        <EditorTable {...tableProps({ ...project, showAudioValidationInTextView: undefined } as unknown as ProjectRecord)} />
      </EditorActionsProvider></QueryClientProvider></MemoryRouter>,
    )
    await screen.findByText("bonjour cell-1")
    expect(screen.queryByTestId("audio-validation-empty")).toBeNull()
    expect(screen.queryByTestId("audio-validation-button")).toBeNull()
  })
})

describe("EditorTable — the Recording tab lists added-track takes", () => {
  it("shows a take block for a take that lives only on an added track", async () => {
    audioState.byCellId = new Map([["cell-1", entry([take("t2", "track-2", "Narration")])]])
    renderTable()
    const row = await rowOf("bonjour cell-1")
    fireEvent.click(within(row).getByRole("button", { name: "Open cell details" }))
    const tab = await screen.findByText("Recording")
    fireEvent.click(tab.closest("button") ?? tab)
    // The block is headed by the take's own name…
    expect(await screen.findByText("Narration")).toBeInTheDocument()
    // …and the panel is not the "no audio yet" empty state.
    expect(screen.queryByText(/no audio yet/i)).toBeNull()
  })

  it("heads an unnamed added-track take by its track", async () => {
    audioState.byCellId = new Map([["cell-1", entry([take("t2", "track-2")])]])
    renderTable()
    const row = await rowOf("bonjour cell-1")
    fireEvent.click(within(row).getByRole("button", { name: "Open cell details" }))
    const tab = await screen.findByText("Recording")
    fireEvent.click(tab.closest("button") ?? tab)
    expect(await screen.findByText("Take on an added track")).toBeInTheDocument()
  })
})
