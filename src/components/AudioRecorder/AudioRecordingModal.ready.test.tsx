// AQU-1217: the recorder's ready screen shows the line's selected take — its
// waveform, its length, a play button — and the target bar judges it, so the
// operator can see and hear what they are about to record over.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

const onlineState = vi.hoisted(() => ({ value: true }))
vi.mock("@/hooks/useOnline", () => ({ useOnline: () => onlineState.value }))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "sam" }, loading: false }),
}))
const recorderState = vi.hoisted(() => ({
  value: { kind: "idle" } as Record<string, unknown>,
}))
const recorderStart = vi.hoisted(() => vi.fn())
const recorderPrewarm = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/useAudioRecorder", () => ({
  useAudioRecorder: () => ({
    state: recorderState.value,
    start: recorderStart,
    stop: vi.fn(),
    reset: vi.fn(),
    prewarm: recorderPrewarm,
  }),
}))
const probeMic = vi.hoisted(() => vi.fn(async () => "granted" as const))
vi.mock("./probeMicPermission", () => ({
  probeMicPermission: (...args: unknown[]) => probeMic(...(args as [])),
}))
const attachmentsState = vi.hoisted(() => ({ byCellId: new Map<string, unknown>() }))
vi.mock("@/hooks/useFileAudioAttachments", () => ({
  useFileAudioAttachments: () => ({ byCellId: attachmentsState.byCellId, isLoading: false, revalidate: vi.fn() }),
  mergeCellsWithAudio: (cells: unknown[]) => cells,
}))
vi.mock("@/lib/audio/voice-generate-helpers", () => ({ generateCellVoice: vi.fn(async () => true) }))
// MUST be mocked: the real probeDurationMsSafe waits on a media element that
// happy-dom will never load, and every upload here would sit for its full 15s
// timeout before the attach event fires.
vi.mock("@/lib/import", () => ({ probeDurationMsSafe: vi.fn(async () => 1000) }))
const injectAttach = vi.hoisted(() => vi.fn())
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: vi.fn(),
  injectOptimisticAudioAttachment: (...args: unknown[]) => injectAttach(...args),
  injectOptimisticAudioRemove: vi.fn(),
}))
const emitAttach = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => "evt-attach"))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellLaneRetime: vi.fn(async () => "evt"),
  emitCellAudioAttach: (...args: unknown[]) => emitAttach(...args),
  emitCellAudioSelect: vi.fn(async () => "evt"),
  emitCellAudioValidate: vi.fn(async () => "evt"),
  emitCellAudioRemove: vi.fn(async () => "evt"),
  emitCellAudioRename: vi.fn(async () => "evt"),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "sync-tok",
}))
const uploadSpy = vi.hoisted(() => vi.fn(async () => ({
  audioId: "audio-c1-999-new", ext: "wav", url: "frontier-audio://audio-c1-999-new.wav",
})))
vi.mock("@/lib/audio/upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: vi.fn(async () => new ArrayBuffer(8)),
  uploadCellAudio: (...args: unknown[]) => uploadSpy(...(args as [])),
  deleteCellAudio: vi.fn(async () => {}),
}))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/audio/transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))
vi.mock("@/lib/audio/transcribe", () => ({ transcribeCell: vi.fn(async () => {}) }))
const activeAudio = vi.hoisted(() => ({ value: null as null | { isPlaying: () => boolean; pause: () => void } }))
vi.mock("@/lib/audio/audio-coordinator", () => ({
  pushAudioShortcutOverride: () => () => {},
  setActiveAudio: () => {},
  clearActiveAudioIf: () => {},
  claimActiveAudio: () => {},
  getActiveAudio: () => activeAudio.value,
}))
// The selected take's player, controllable per test.
const player = vi.hoisted(() => ({
  selected: [] as Array<string | undefined>,
  trims: [] as Array<[number | null, number | null]>,
  play: vi.fn(async () => {}),
  pause: vi.fn(),
  isPlaying: false,
}))
vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: (_p: unknown, cell: { metadata?: { selectedAudioId?: string } }) => {
    player.selected.push(cell.metadata?.selectedAudioId)
    return {
      state: "ready", error: null, isPlaying: player.isPlaying, currentTime: 0, duration: 4.1,
      peaks: new Float32Array([0.2, 0.9, 0.5, 0.7]), peaksState: "ready",
      play: player.play, pause: player.pause, seek: vi.fn(), setVolume: vi.fn(),
      setTrim: (s: number | null, e: number | null) => { player.trims.push([s, e]) },
      requestPeaks: vi.fn(async () => {}), ensureBytes: vi.fn(async () => new Uint8Array()),
    }
  },
}))

import { AudioRecordingModal } from "./AudioRecordingModal"
import { renderWithTooltips, expectTooltip } from "@/test-utils/tooltip"

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord
const cell = {
  id: "c1", fileId: "f1", original: "hello", translated: "bonjour",
  medium: "media", startTime: 0, endTime: 2.5,
} as unknown as CellData

const take = (id: string, over: Record<string, unknown> = {}) => ({
  audioId: id, url: `frontier-audio://${id}`, slot: "recording", label: null, mimeType: "audio/wav",
  voiceId: null, referenceAudioId: null, durationMs: 3600, trimStartMs: null, trimEndMs: null, ...over,
})

function entry(over: Record<string, unknown>) {
  return new Map([["c1", {
    selectedAudioId: null, selectedGeneratedVoiceAudioId: null, audioTimings: {}, attachments: {}, ...over,
  }]])
}

function modalEl(targetSlot?: string, p: ProjectRecord = project) {
  return (
    <AudioRecordingModal
      open project={p} cells={[cell]} activeCellId="c1" username="sam" targetSlot={targetSlot}
      onActiveCellChange={() => {}} onTakeSaved={() => {}} onClose={() => {}}
    />
  )
}

beforeEach(() => {
  onlineState.value = true
  recorderState.value = { kind: "idle" }
  attachmentsState.byCellId = new Map()
  player.selected.length = 0
  player.trims.length = 0
  player.play.mockClear()
  player.pause.mockClear()
  player.isPlaying = false
  activeAudio.value = null
})

describe("the selected take, before recording", () => {
  it("shows its waveform, name and length at once, and the bar judges it", () => {
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-c1-3.wav",
      attachments: { "audio-c1-3.wav": take("audio-c1-3.wav", { label: "Take 3" }) },
    })
    render(modalEl())
    expect(screen.getByTestId("rec-ready-take")).toHaveTextContent("Take 3 · 3.6s")
    expect(screen.getByTestId("rec-ready-waveform-shape")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Play audio" })).toBeInTheDocument()
    // 3.6s against a 2.5s cue: over at a glance, before anyone records.
    expect(screen.getByText("0:03.6")).toBeInTheDocument()
    expect(player.selected.at(-1)).toBe("audio-c1-3.wav")
  })

  // Sam, 2026-09-26: the take wears its track's colour, the one stored with
  // its file — the same one the timeline and the Audio view draw it in.
  it("wears its file's dub-track colour", () => {
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-c1-3.wav",
      attachments: { "audio-c1-3.wav": take("audio-c1-3.wav", { label: "Take 3" }) },
    })
    const coloured = { ...project, files: [{ id: "f1", trackOverrides: { "target-audio": { color: "violet" } } }] } as unknown as ProjectRecord
    render(modalEl(undefined, coloured))
    expect(screen.getByTestId("rec-ready-waveform").style.getPropertyValue("--tl-track-hue")).toBe("#865deb")
  })

  // Live walk, 2026-09-25: a 3.06s take read "3.1s" above a bar reading
  // "0:03.0". Both round the tenths down now.
  it("states the length exactly as the bar under it does", () => {
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-c1-3.wav",
      attachments: { "audio-c1-3.wav": take("audio-c1-3.wav", { label: "Take 3", durationMs: 3060 }) },
    })
    render(modalEl())
    expect(screen.getByTestId("rec-ready-take")).toHaveTextContent("Take 3 · 3.0s")
    expect(screen.getByText("0:03.0")).toBeInTheDocument()
  })

  // Sam, 2026-09-28: the room went to the takes drawer, so on a line with no
  // timed window the note is a tooltip on an icon beside the take, not a line.
  it("says a line has no timed window on hover, beside the take, compact", async () => {
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-c1-3.wav",
      attachments: { "audio-c1-3.wav": take("audio-c1-3.wav", { label: "Take 3" }) },
    })
    const untimed = { ...cell, startTime: undefined, endTime: undefined } as unknown as CellData
    renderWithTooltips(
      <AudioRecordingModal
        open project={project} cells={[untimed]} activeCellId="c1" username="sam"
        onActiveCellChange={() => {}} onTakeSaved={() => {}} onClose={() => {}}
      />,
    )
    const icon = screen.getByTestId("rec-no-window")
    expect(screen.getByTestId("rec-ready-take").contains(icon)).toBe(true)
    await expectTooltip(icon, "This line has no timed window.")
    expect(screen.queryByText("This line has no timed window.", { selector: "p" })).toBeNull()
    expect(screen.getByTestId("rec-ready-waveform").style.height).toBe("40px")
  })

  it("keeps the note as a line where there is no take to hang it on", () => {
    const untimed = { ...cell, startTime: undefined, endTime: undefined } as unknown as CellData
    render(
      <AudioRecordingModal
        open project={project} cells={[untimed]} activeCellId="c1" username="sam"
        onActiveCellChange={() => {}} onTakeSaved={() => {}} onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId("rec-no-window")).toBeNull()
    expect(screen.getByText("This line has no timed window.")).toBeInTheDocument()
  })

  it("shows today's empty window on a line with no take", () => {
    render(modalEl())
    expect(screen.queryByTestId("rec-ready-take")).toBeNull()
    expect(screen.getByText("0:00.0")).toBeInTheDocument()
  })

  it("shows and plays a take trimmed elsewhere at its trimmed length", () => {
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-c1-3.wav",
      attachments: { "audio-c1-3.wav": take("audio-c1-3.wav", { label: "Take 3", trimStartMs: 300, trimEndMs: 2700 }) },
    })
    render(modalEl())
    expect(screen.getByTestId("rec-ready-take")).toHaveTextContent("Take 3 · 2.4s")
    expect(player.trims.at(-1)).toEqual([0.3, 2.7])
    // Shown, not edited here: the lines are grey and inert.
    expect(screen.getByRole("slider", { name: "Start of the kept audio" })).toHaveAttribute("aria-readonly", "true")
  })

  it("falls back to the generated voice when the recording slot holds no take", () => {
    attachmentsState.byCellId = entry({
      selectedGeneratedVoiceAudioId: "gen-c1-1.wav",
      attachments: { "gen-c1-1.wav": take("gen-c1-1.wav", { slot: "generatedVoice" }) },
    })
    render(modalEl())
    expect(screen.getByTestId("rec-ready-take")).toBeInTheDocument()
    expect(player.selected.at(-1)).toBe("gen-c1-1.wav")
  })

  it("shows the take on the track being recorded onto", () => {
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-c1-3.wav",
      selectedBySlot: { recording: "audio-c1-3.wav", "track-2": "audio-c1-t2.wav" },
      attachments: {
        "audio-c1-3.wav": take("audio-c1-3.wav"),
        "audio-c1-t2.wav": take("audio-c1-t2.wav", { slot: "track-2" }),
      },
    })
    render(modalEl("track-2"))
    expect(player.selected.at(-1)).toBe("audio-c1-t2.wav")
  })

  it("never offers the imported source clip as a take", () => {
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-f1-src.wav",
      attachments: { "audio-f1-src.wav": take("audio-f1-src.wav") },
    })
    render(modalEl())
    expect(screen.queryByTestId("rec-ready-take")).toBeNull()
  })

  it("swaps when a different take is circled", () => {
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-c1-3.wav",
      attachments: { "audio-c1-3.wav": take("audio-c1-3.wav"), "audio-c1-2.wav": take("audio-c1-2.wav") },
    })
    const { rerender } = render(modalEl())
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-c1-2.wav",
      attachments: { "audio-c1-3.wav": take("audio-c1-3.wav"), "audio-c1-2.wav": take("audio-c1-2.wav") },
    })
    rerender(modalEl())
    expect(player.selected.at(-1)).toBe("audio-c1-2.wav")
  })

  it("silences a playing audition before it plays", async () => {
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-c1-3.wav",
      attachments: { "audio-c1-3.wav": take("audio-c1-3.wav") },
    })
    const audition = { isPlaying: () => true, pause: vi.fn() }
    activeAudio.value = audition
    render(modalEl())
    fireEvent.click(screen.getByRole("button", { name: "Play audio" }))
    await waitFor(() => expect(player.play).toHaveBeenCalled())
    expect(audition.pause).toHaveBeenCalled()
  })

  it("gives way to the countdown, and stops sounding", async () => {
    attachmentsState.byCellId = entry({
      selectedAudioId: "audio-c1-3.wav",
      attachments: { "audio-c1-3.wav": take("audio-c1-3.wav") },
    })
    render(modalEl())
    fireEvent.click(screen.getByTestId("rec-start"))
    await waitFor(() => expect(screen.queryByTestId("rec-ready-take")).toBeNull())
    expect(player.pause).toHaveBeenCalled()
  })
})

// Sam, 2026-09-28: without the film, the drawer can be pulled up over the line
// and the instruments to see every take at once — as the film layout raises
// its list.
describe("the takes drawer, pulled up", () => {
  const twoTakes = () => entry({
    selectedAudioId: "audio-c1-3.wav",
    attachments: {
      "audio-c1-2.wav": take("audio-c1-2.wav", { label: "Take 2" }),
      "audio-c1-3.wav": take("audio-c1-3.wav", { label: "Take 3" }),
    },
  })
  const draw = (onClose = vi.fn()) => {
    render(
      <AudioRecordingModal
        open project={project} cells={[cell]} activeCellId="c1" username="sam"
        onActiveCellChange={() => {}} onTakeSaved={() => {}} onClose={onClose}
      />,
    )
    return { toggle: screen.getByTestId("rec-takes-toggle"), onClose }
  }
  const sheet = () => screen.getByTestId("rec-takes-group").getAttribute("data-sheet")
  const lineCovered = () => screen.getByTestId("rec-read-aloud").closest("[inert]") != null

  it("has a handle left of Takes that raises the takes over the line, and puts them back", () => {
    attachmentsState.byCellId = twoTakes()
    const { toggle } = draw()
    expect(toggle.firstElementChild?.tagName.toLowerCase()).toBe("svg")
    expect(toggle).toHaveTextContent("Takes 2")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(sheet()).toBe("down")
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    // Risen from the bottom, as tall as its takes (the height is the
    // browser's; the live walk measures it) — the line is covered, not gone.
    expect(sheet()).toBe("up")
    expect(screen.getByTestId("rec-takes-group").className).toContain("bottom-0")
    expect(lineCovered()).toBe(true)
    fireEvent.click(toggle)
    expect(sheet()).toBe("down")
    expect(lineCovered()).toBe(false)
  })

  it("goes down on Escape, before anything closes", () => {
    attachmentsState.byCellId = twoTakes()
    const { toggle, onClose } = draw()
    fireEvent.click(toggle)
    // Pressed where focus is, so the dialog's own Escape handling sees it too.
    toggle.focus()
    fireEvent.keyDown(toggle, { key: "Escape" })
    expect(screen.getByTestId("rec-takes-toggle")).toHaveAttribute("aria-expanded", "false")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("goes down when a take starts, so the line is never under it", () => {
    attachmentsState.byCellId = twoTakes()
    const { toggle } = draw()
    fireEvent.click(toggle)
    fireEvent.keyDown(window, { key: " " })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(sheet()).toBe("down")
  })

  it("has nothing to pull up on a line with no takes", () => {
    const { toggle } = draw()
    expect(toggle).toBeDisabled()
  })
})
