// The Recording tab as one job (Sam, 2026-09-29): per track, the take that
// plays on top and the others listed under it; the programme section when no
// take plays; a heard line's takes last, with their warning and their vote.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "ready", error: null, isPlaying: false, currentTime: 0, duration: 3,
    peaks: null, peaksState: "idle",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
const historyReads: Array<{ enabled: boolean; cellId: string | null }> = []
vi.mock("@/hooks/useRecordingTextDrift", () => ({
  useRecordingTextDrift: (opts: { enabled: boolean; cellId: string | null }) => { historyReads.push(opts); return new Map() },
}))
vi.mock("@/lib/audio/peaks-loader", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/peaks-loader")>()),
  loadPeaksFor: vi.fn(async () => null),
}))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async () => "e"), emitCellAudioTrim: vi.fn(async () => "e"),
  emitCellAudioSelect: vi.fn(async () => "e"), emitCellAudioDeselect: vi.fn(async () => "e"),
  emitCellAudioRemove: vi.fn(async () => "e"), emitCellAudioRename: vi.fn(async () => "e"),
  emitCellAudioValidate: vi.fn(async () => "e"), emitCellAudioUnvalidate: vi.fn(async () => "e"),
}))

import { RecordingTakes } from "./RecordingTakes"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

const project = { id: "p1", sourceLanguage: "en", targetLanguage: "es", audioMediaStrategy: "manual", files: [{ id: "f1" }] } as unknown as ProjectRecord
const audio = (url: string, slot: string, over: Record<string, unknown> = {}) => ({ type: "audio", url, slot, durationMs: 3000, ...over })

function cell(over: Partial<CellData> & { attachments: Record<string, unknown> }): CellData {
  return { id: "c1", fileId: "f1", original: "", translated: "", ...over } as unknown as CellData
}

function draw(c: CellData, linkedTakes?: Array<{ cell: CellData; sharedWith: number }>) {
  render(
    <RecordingTakes
      project={project} cell={c} linkedTakes={linkedTakes}
      cellText="Te he llamado por tu nombre" editable username="dir" session={{ jwt: "j", username: "dir" } as never}
      onOpenRecording={vi.fn()} onUseAsCellText={vi.fn()}
    />,
  )
}

const REC = "audio-c1-2.wav", GEN = "audio-c1-3.wav", OLD = "audio-c1-1.wav"

beforeEach(() => { historyReads.length = 0 })

describe("RecordingTakes", () => {
  it("puts the recording that plays on top and lists the other two under it — Cell 6", () => {
    draw(cell({
      selectedAudioId: REC, selectedGeneratedVoiceAudioId: GEN,
      attachments: {
        [OLD]: audio("frontier-audio://1", "recording", { label: "Take 1" }),
        [REC]: audio("frontier-audio://2", "recording", { label: "Take 2" }),
        [GEN]: audio("frontier-audio://3", "generatedVoice", { label: "Take 3", voiceId: "maria" }),
      },
    }))
    expect(screen.getByTestId("cell-take-label")).toHaveTextContent("Take 2")
    const others = screen.getByTestId("tab-other-takes")
    expect(within(others).getByText("2 other takes")).toBeInTheDocument()
    expect(within(others).getByTestId(`take-row-${GEN}`)).toBeInTheDocument()
    expect(within(others).getByTestId(`take-row-${OLD}`)).toBeInTheDocument()
    expect(within(others).queryByTestId(`take-row-${REC}`)).toBeNull()
  })

  it("puts the generated voice on top once the recording slot is empty", () => {
    draw(cell({
      selectedAudioId: undefined, selectedGeneratedVoiceAudioId: GEN,
      attachments: {
        [REC]: audio("frontier-audio://2", "recording", { label: "Take 2" }),
        [GEN]: audio("frontier-audio://3", "generatedVoice", { label: "Take 3", voiceId: "maria" }),
      },
    }))
    expect(screen.getByTestId("cell-take-label")).toHaveTextContent("Take 3")
    expect(within(screen.getByTestId("tab-other-takes")).getByTestId(`take-row-${REC}`)).toBeInTheDocument()
  })

  it("gives each track its own section, with the take that plays on each", () => {
    draw(cell({
      selectedAudioId: REC,
      selectedBySlot: { recording: REC, "trk-2": "audio-c1-t2.wav" },
      attachments: {
        [REC]: audio("frontier-audio://2", "recording", { label: "Take 2" }),
        "audio-c1-t2.wav": audio("frontier-audio://t2", "trk-2", { label: "Take 1" }),
      },
    }))
    expect(screen.getByTestId("rec-tab-track-target-audio")).toBeInTheDocument()
    expect(within(screen.getByTestId("rec-tab-track-trk-2")).getByTestId("cell-take-label")).toHaveTextContent("Take 1")
    expect(screen.getAllByText("Plays for this line")).toHaveLength(2)
  })

  it("shows the programme's section when no take plays on a media line", () => {
    draw(cell({
      selectedAudioId: "audio-f1-src.wav",
      medium: "media", startTime: 2, endTime: 5,
      attachments: { "audio-f1-src.wav": audio("frontier-audio://src", "recording", { role: "source", durationMs: 60000 }) },
    } as Partial<CellData> & { attachments: Record<string, unknown> }))
    expect(screen.getByTestId("cell-take-label")).toHaveTextContent("Source audio")
    expect(screen.queryByTestId("tab-other-takes")).toBeNull()
  })

  it("says nothing plays, and offers New take, when every take is set aside", () => {
    draw(cell({
      selectedAudioId: undefined, selectedGeneratedVoiceAudioId: undefined,
      attachments: { [REC]: audio("frontier-audio://2", "recording", { label: "Take 2" }) },
    }))
    const none = screen.getByTestId("rec-tab-none-plays")
    expect(none).toHaveTextContent("No take plays for this line")
    expect(within(none).getByRole("button", { name: /new take/i })).toBeInTheDocument()
    expect(within(screen.getByTestId("tab-other-takes")).getByText("1 other take")).toBeInTheDocument()
  })

  it("reads each cell's take history once, for its playing take and its list together", () => {
    draw(cell({
      selectedAudioId: REC,
      attachments: {
        [OLD]: audio("frontier-audio://1", "recording"),
        [REC]: audio("frontier-audio://2", "recording"),
      },
    }))
    const enabled = historyReads.filter((r) => r.enabled)
    expect(new Set(enabled.map((r) => r.cellId))).toEqual(new Set(["c1"]))
    // The list's own read stays off: it was handed the tab's.
    expect(historyReads.some((r) => !r.enabled)).toBe(true)
  })

  it("lists a heard line's takes last, warns that others change too, and takes its vote", () => {
    const cue = cell({
      id: "cue-1", fileId: "cue-sib", startTime: 12.3, endTime: 14.8,
      selectedAudioId: "audio-cue-1-a.wav",
      attachments: {
        "audio-cue-1-a.wav": audio("frontier-audio://a", "recording", { label: "Take 1", validators: [] }),
        "audio-cue-1-b.wav": audio("frontier-audio://b", "recording", { label: "Take 2", validators: [] }),
      },
    } as Partial<CellData> & { attachments: Record<string, unknown> })
    draw(cell({ attachments: {} }), [{ cell: cue, sharedWith: 3 }])
    expect(screen.getByTestId("cell-linked-take")).toHaveTextContent("Heard line")
    expect(screen.getByTestId("rec-tab-shared-note")).toHaveTextContent("Using another take changes what 2 other lines play too.")
    // The vote is on the heard line's PLAYING take; its list shows the other
    // take's validation read-only.
    const playing = within(screen.getByTestId("cell-take-block")).getByTestId("audio-validation-button")
    expect(playing.getAttribute("aria-label")).toMatch(/click to validate/i)
    const listed = within(screen.getByTestId("tab-other-takes")).getByTestId("audio-validation-button")
    expect(listed.getAttribute("aria-label")).not.toMatch(/click/i)
  })
})
