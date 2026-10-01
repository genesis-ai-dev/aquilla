/**
 * AQU-490, after Sam's first manual pass (2026-09-21):
 *
 * 1. The switch is resolved once per FILE, not per cell — but a line with no
 *    recording still draws no control, exactly as a cell with no text has no
 *    text control. (A placeholder mic was tried and rejected the same day.)
 * 2. The Recording tab lists a take that lives on an ADDED track. It did not,
 *    so a line whose only recording sat off the default track opened to an
 *    empty panel — the attention dot said audio, the panel said nothing.
 *
 * Real EditorTable, real rows, mocked list virtualiser (happy-dom has no
 * layout) and a mocked per-file audio read so the takes can be shaped exactly.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
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
import type { CellData } from "@/hooks/useCells"
import type { LinkedTake } from "@/lib/audio/linked-takes"
import { __resetFileAudioMemoryForTests } from "@/lib/audio/file-has-audio"

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
const audioState = vi.hoisted(() => ({ byCellId: new Map<string, CellAudioEntry>(), hasLoaded: true }))
vi.mock("@/hooks/useFileAudioAttachments", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFileAudioAttachments: () => ({
    byCellId: audioState.byCellId, isLoading: false, hasLoaded: audioState.hasLoaded, revalidate: vi.fn(),
  }),
}))
// The votes, caught rather than sent; the flush-then-refresh after one is a
// no-op here.
const emits = vi.hoisted(() => ({ validate: vi.fn(async (_: unknown) => undefined) }))
vi.mock("@/lib/sync/events-emit", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitCellAudioValidate: emits.validate,
}))
vi.mock("@/lib/audio/audio-validation-commit", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAudioValidationCommit: () => async () => undefined,
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

// Which files were last seen with audio is session memory; each test starts
// with none.
beforeEach(() => __resetFileAudioMemoryForTests())

describe("EditorTable — audio validation across the whole gutter", () => {
  it("draws a control on the line with a recording and a faded mic on the line without", async () => {
    audioState.byCellId = new Map([["cell-1", entry([take("t1", "recording")])]])
    renderTable()
    const withTake = await rowOf("bonjour cell-1")
    const without = await rowOf("bonjour cell-2")
    expect(within(withTake).getByTestId("audio-validation-button")).toBeInTheDocument()
    expect(within(withTake).queryByTestId("audio-validation-unavailable")).toBeNull()
    expect(within(without).queryByTestId("audio-validation-button")).toBeNull()
    expect(within(without).getByTestId("audio-validation-unavailable")).toBeInTheDocument()
  })

  // AQU-1495 (Sam, 2026-10-01): the column belongs to files with audio. Until
  // then a file with none drew a faded mic on every line (09-23), so removing
  // a project's last recording left the column standing, and a text-only
  // project wore it on every line it had.
  it("draws no audio column when the file has no audio at all", async () => {
    audioState.byCellId = new Map()
    renderTable()
    await screen.findByText("bonjour cell-1")
    expect(screen.queryByTestId("audio-validation-gutter")).toBeNull()
    expect(screen.queryByTestId("audio-validation-unavailable")).toBeNull()
    // The text column is untouched.
    expect(screen.getAllByTestId("validation-gutter")).toHaveLength(2)
  })

  // …and neither does the header, whose marks stand over the rows' columns.
  it("marks only the text checks in the header of a file with no audio", async () => {
    audioState.byCellId = new Map()
    renderTable()
    await screen.findByText("bonjour cell-1")
    const marks = screen.getByTestId("table-check-marks")
    expect(within(marks).getByRole("img", { name: "Text validation" })).toBeInTheDocument()
    expect(within(marks).queryByRole("img", { name: "Audio validation" })).toBeNull()
  })

  it("marks both checks in the header of a file with audio", async () => {
    audioState.byCellId = new Map([["cell-1", entry([take("t1", "recording")])]])
    renderTable()
    await rowOf("bonjour cell-1")
    const marks = screen.getByTestId("table-check-marks")
    expect(within(marks).getByRole("img", { name: "Text validation" })).toBeInTheDocument()
    expect(within(marks).getByRole("img", { name: "Audio validation" })).toBeInTheDocument()
  })
})

// AQU-1495, from Joel's report of the 2026-09-29 call: the board's audio bar
// went when the last recording was removed, and the editor's mic stayed.
describe("EditorTable — removing recordings", () => {
  function ui() {
    return (
      <MemoryRouter><QueryClientProvider client={new QueryClient()}><EditorActionsProvider value={{}}>
        <EditorTable {...tableProps(project)} />
      </EditorActionsProvider></QueryClientProvider></MemoryRouter>
    )
  }

  it("takes the column away with the file's last recording", async () => {
    audioState.byCellId = new Map([["cell-1", entry([take("t1", "recording")])]])
    const { rerender } = render(ui())
    expect(within(await rowOf("bonjour cell-1")).getByTestId("audio-validation-button")).toBeInTheDocument()

    audioState.byCellId = new Map()
    rerender(ui())
    await screen.findByText("bonjour cell-1")
    expect(screen.queryByTestId("audio-validation-gutter")).toBeNull()
  })

  it("keeps the column when other lines still have audio, and fades only the emptied line", async () => {
    audioState.byCellId = new Map([
      ["cell-1", entry([take("t1", "recording")])],
      ["cell-2", entry([take("t2", "recording")])],
    ])
    const { rerender } = render(ui())
    expect(within(await rowOf("bonjour cell-2")).getByTestId("audio-validation-button")).toBeInTheDocument()

    audioState.byCellId = new Map([["cell-1", entry([take("t1", "recording")])]])
    rerender(ui())
    const kept = await rowOf("bonjour cell-1")
    const emptied = await rowOf("bonjour cell-2")
    expect(within(kept).getByTestId("audio-validation-button")).toBeInTheDocument()
    expect(within(emptied).queryByTestId("audio-validation-button")).toBeNull()
    expect(within(emptied).getByTestId("audio-validation-unavailable")).toBeInTheDocument()
  })
})

describe("EditorTable — a line with only audio", () => {
  // Sam, 2026-09-22: an audio-only line offered BOTH controls, so you could
  // "validate" a translation that did not exist. Only the mic now.
  it("gets the audio control and not the text one", async () => {
    audioState.byCellId = new Map([["cell-1", entry([take("t1", "recording")])]])
    const s = store()
    // Blank the target text on cell-1, keeping its take.
    s.replaceRows(
      [...rows("cell-1", "GEN 1:1"), ...rows("cell-2", "GEN 1:2")].map((r) =>
        r.cellId === "cell-1" && r.side === "target" ? { ...r, value: "" } : r,
      ),
      { full: true, maxServerSeq: 2 },
    )
    render(
      <MemoryRouter><QueryClientProvider client={new QueryClient()}><EditorActionsProvider value={{}}>
        <EditorTable {...tableProps(project)} cellStore={s} />
      </EditorActionsProvider></QueryClientProvider></MemoryRouter>,
    )
    await rowOf("bonjour cell-2")
    // cell-1 has no target text to find it by; it is the grid row that is NOT cell-2.
    const audioOnly = Array.from(document.querySelectorAll<HTMLElement>("[data-grid-row]"))
      .find((r) => !r.textContent?.includes("bonjour cell-2"))!
    expect(audioOnly).toBeDefined()
    // Its text gutter holds only the faded circle — no button to press; its
    // audio slot is live.
    const textGutter = audioOnly.querySelector('[data-testid="validation-gutter"]')
    expect(textGutter?.querySelector("button")).toBeNull()
    expect(textGutter?.querySelector('[data-testid="validation-unavailable"]')).not.toBeNull()
    expect(within(audioOnly).getByTestId("audio-validation-button")).toBeInTheDocument()
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

  // Sam, 2026-09-30: named by its track before its own name. A track this
  // build cannot name is still named as a track.
  it("names the track of a take that lives on an added track", async () => {
    audioState.byCellId = new Map([["cell-1", entry([take("t2", "track-2")])]])
    renderTable()
    const row = await rowOf("bonjour cell-1")
    fireEvent.click(within(row).getByRole("button", { name: "Open cell details" }))
    const tab = await screen.findByText("Recording")
    fireEvent.click(tab.closest("button") ?? tab)
    expect(await screen.findByTestId("cell-take-track")).toHaveTextContent("Added track")
  })
})

// Sam, 2026-09-30: in a dubbing file a subtitle line's takes live on the heard
// lines (cues) performing it. The line's audio check read only the row, so it
// said "No audio to validate", and a vote on the heard line never showed.
describe("EditorTable — a subtitle line's audio check reaches its heard lines", () => {
  const cue = (id: string, audioId: string | null, words: string, validators: string[] = []): CellData => ({
    id, fileId: "cue-file", original: words, translated: "", startTime: 1, endTime: 2,
    attachments: audioId
      ? { [audioId]: { ...take(audioId, "recording"), validators, validatorCount: validators.length } }
      : {},
    selectedAudioId: audioId,
    selectedGeneratedVoiceAudioId: null,
  } as unknown as CellData)

  function renderWith(linked: Map<string, LinkedTake[]>) {
    audioState.byCellId = new Map()
    return render(
      <MemoryRouter><QueryClientProvider client={new QueryClient()}><EditorActionsProvider value={{}}>
        <EditorTable {...tableProps(project)} linkedTakesByCell={linked} />
      </EditorActionsProvider></QueryClientProvider></MemoryRouter>,
    )
  }

  it("draws the heard line's take, and votes on it where it lives", async () => {
    emits.validate.mockClear()
    renderWith(new Map([["cell-1", [{ cell: cue("cue-a", "ta", "Bring back some bread,"), sharedWith: 1, hasTake: true, performs: ["cell-1"], partOfSplit: false }]]]))
    const row = await rowOf("bonjour cell-1")
    expect(within(row).queryByTestId("audio-validation-unavailable")).toBeNull()
    fireEvent.click(within(row).getByTestId("audio-validation-button"))
    await vi.waitFor(() => expect(emits.validate).toHaveBeenCalledTimes(1))
    expect(emits.validate.mock.calls[0][0]).toMatchObject({ fileId: "cue-file", cellId: "cue-a", audioId: "ta" })
  })

  it("shows a vote cast on the heard line elsewhere", async () => {
    renderWith(new Map([["cell-1", [{ cell: cue("cue-a", "ta", "Bring back some bread,", ["someone"]), sharedWith: 1, hasTake: true, performs: ["cell-1"], partOfSplit: false }]]]))
    const row = await rowOf("bonjour cell-1")
    // Validated by another at a threshold of one: the double check, which
    // offers nothing to press.
    expect(within(row).getByTestId("audio-validation-button")).toHaveAttribute(
      "aria-label", expect.stringContaining("validated"),
    )
    expect(within(row).getByTestId("audio-validation-button").className).toContain("text-green-500")
  })
})

// The 3G pass (Sam, 2026-10-01): until the file's recordings had been read,
// every line said "No audio to validate", then changed its mind seconds later.
// An empty answer before the read means "not known yet" — the slot holds a
// placeholder, and in a dubbing file it waits for the heard lines' takes too,
// so a line never shows a count that is about to change. AQU-1495: only where
// audio is expected, so a text-only file never pulses on every line.
describe("EditorTable — the audio check waits for the file's recordings", () => {
  afterEach(() => { audioState.hasLoaded = true })

  it("holds a placeholder on every line of a file last seen with audio", async () => {
    // Read once with a recording on it…
    audioState.byCellId = new Map([["cell-1", entry([take("t1", "recording")])]])
    const first = renderTable()
    await rowOf("bonjour cell-1")
    first.unmount()
    // …then opened again, its recordings not yet read.
    audioState.byCellId = new Map()
    audioState.hasLoaded = false
    renderTable()
    await screen.findByText("bonjour cell-1")
    expect(screen.getAllByTestId("audio-validation-checking")).toHaveLength(2)
    expect(screen.queryByTestId("audio-validation-unavailable")).toBeNull()
    expect(screen.queryByTestId("audio-validation-button")).toBeNull()
  })

  it("draws nothing while reading a file not known to have audio", async () => {
    audioState.byCellId = new Map()
    audioState.hasLoaded = false
    renderTable()
    await screen.findByText("bonjour cell-1")
    expect(screen.queryByTestId("audio-validation-gutter")).toBeNull()
  })

  // Switching files, the read can still hold the previous file's answer until
  // the new one is back. It says nothing about this file.
  it("does not judge an unread file by what the read still holds", async () => {
    audioState.byCellId = new Map([["cell-1", entry([take("t1", "recording")])]])
    audioState.hasLoaded = false
    renderTable()
    await screen.findByText("bonjour cell-1")
    expect(screen.queryByTestId("audio-validation-gutter")).toBeNull()
  })

  it("takes the placeholder away when a file expected to have audio turns out to have none", async () => {
    audioState.byCellId = new Map([["cell-1", entry([take("t1", "recording")])]])
    renderTable().unmount()
    audioState.byCellId = new Map()
    audioState.hasLoaded = false
    const { rerender } = renderTable()
    await screen.findByText("bonjour cell-1")
    expect(screen.getAllByTestId("audio-validation-checking")).toHaveLength(2)

    audioState.hasLoaded = true
    rerender(
      <MemoryRouter><QueryClientProvider client={new QueryClient()}><EditorActionsProvider value={{ onOpenRecording: vi.fn() }}>
        <EditorTable {...tableProps(project)} />
      </EditorActionsProvider></QueryClientProvider></MemoryRouter>,
    )
    await screen.findByText("bonjour cell-1")
    expect(screen.queryByTestId("audio-validation-gutter")).toBeNull()
  })

  it("in a dubbing file, waits for the heard lines' takes before saying anything", async () => {
    audioState.byCellId = new Map([["cell-1", entry([take("t1", "recording")])]])
    const ui = (heardLinesLoading: boolean) => (
      <MemoryRouter><QueryClientProvider client={new QueryClient()}><EditorActionsProvider value={{}}>
        <EditorTable {...tableProps(project)} heardLinesLoading={heardLinesLoading} />
      </EditorActionsProvider></QueryClientProvider></MemoryRouter>
    )
    const { rerender } = render(ui(true))
    await screen.findByText("bonjour cell-1")
    // The line's own take is known, but a heard line may add another: no
    // control yet, on either line.
    expect(screen.getAllByTestId("audio-validation-checking")).toHaveLength(2)
    expect(screen.queryByTestId("audio-validation-button")).toBeNull()

    rerender(ui(false))
    const withTake = await rowOf("bonjour cell-1")
    const without = await rowOf("bonjour cell-2")
    expect(screen.queryByTestId("audio-validation-checking")).toBeNull()
    expect(within(withTake).getByTestId("audio-validation-button")).toBeInTheDocument()
    expect(within(without).getByTestId("audio-validation-unavailable")).toBeInTheDocument()
  })
})
