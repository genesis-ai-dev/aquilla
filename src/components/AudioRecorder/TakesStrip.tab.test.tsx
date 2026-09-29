// The takes list as the expanded cell's Recording tab draws it (Sam,
// 2026-09-29): the line's OTHER takes — the one that plays is drawn above —
// each with its shape and how it compares with the text, the tools on hover,
// and the same selecting as the recorder.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import type { ProjectRecord } from "@/lib/parsers/types"

const emitSelect = vi.fn(async (..._args: unknown[]) => "evt-1")
const emitDeselect = vi.fn(async (..._args: unknown[]) => "evt-2")
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioSelect: (...args: unknown[]) => emitSelect(...args),
  emitCellAudioDeselect: (...args: unknown[]) => emitDeselect(...args),
  emitCellAudioRemove: vi.fn(async () => "evt-3"),
  emitCellAudioRename: vi.fn(async () => "evt-4"),
  emitCellAudioValidate: vi.fn(async () => "evt-5"),
  emitCellAudioUnvalidate: vi.fn(async () => "evt-6"),
}))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: vi.fn(),
  injectOptimisticAudioAttachment: vi.fn(),
  injectOptimisticAudioRemove: vi.fn(),
  injectOptimisticAudioDeselect: vi.fn(),
  retryFailedAudioSync: vi.fn(),
}))
const driftCalls: Array<{ enabled: boolean }> = []
vi.mock("@/hooks/useRecordingTextDrift", () => ({
  useRecordingTextDrift: (opts: { enabled: boolean }) => { driftCalls.push(opts); return new Map() },
}))
const loadPeaks = vi.fn(async () => null)
vi.mock("@/lib/audio/peaks-loader", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio/peaks-loader")>()),
  loadPeaksFor: (...args: unknown[]) => loadPeaks(...(args as [])),
}))

import { TakesStrip } from "./TakesStrip"

const session = { jwt: "jwt", username: "dir" } as never
const project = { id: "p1", name: "P", audioMediaStrategy: "lazy", files: [] } as unknown as ProjectRecord
const att = (audioId: string, slot = "recording", over: Partial<AudioAttachmentOut> = {}): AudioAttachmentOut => ({
  audioId, url: `frontier-audio://${audioId}`, slot, mimeType: "audio/wav", voiceId: null, referenceAudioId: null,
  durationMs: 3000, trimStartMs: null, trimEndMs: null, label: null, ...over,
} as AudioAttachmentOut)

const REC = att("audio-c1-2.wav", "recording", { label: "Take 2" })
const GEN = att("audio-c1-3.wav", "generatedVoice", { label: "Take 3", voiceId: "maria" })
const OLD = att("audio-c1-1.wav", "recording", { label: "Take 1" })
const TEXT = "Te he llamado por tu nombre"

function draw(over: Partial<React.ComponentProps<typeof TakesStrip>> = {}) {
  return render(
    <TakesStrip
      variant="tab"
      projectId="p1" project={project} fileId="f1" cellId="c1"
      takes={[OLD, REC, GEN]} hide={[REC.audioId]}
      selectedAudioId={REC.audioId} selectedGeneratedAudioId={GEN.audioId}
      author="dir" session={session}
      cellText={TEXT}
      timingsFor={(id) => id === OLD.audioId
        ? [{ word: "Te", end: 2 }, { word: "llamé", end: 8 }, { word: "por", end: 12 }, { word: "tu", end: 15 }, { word: "nombre", end: 22 }]
        : undefined}
      {...over}
    />,
  )
}

beforeEach(() => { emitSelect.mockClear(); emitDeselect.mockClear(); loadPeaks.mockClear(); driftCalls.length = 0 })

describe("TakesStrip — the Recording tab's list of other takes", () => {
  it("leaves out the take that plays and says how many others there are", () => {
    draw()
    expect(screen.getByText("2 other takes")).toBeInTheDocument()
    expect(screen.queryByTestId(`take-row-${REC.audioId}`)).toBeNull()
    expect(screen.getByTestId(`take-row-${OLD.audioId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`take-row-${GEN.audioId}`)).toBeInTheDocument()
  })

  it("draws nothing when the playing take is the only one", () => {
    const { container } = draw({ takes: [REC] })
    expect(container).toBeEmptyDOMElement()
  })

  it("draws each take's shape, fetched once per take", () => {
    draw()
    expect(screen.getByTestId(`take-row-wave-${OLD.audioId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`take-row-wave-${GEN.audioId}`)).toBeInTheDocument()
    expect(loadPeaks).toHaveBeenCalledTimes(2)
  })

  it("does not fetch shapes on a project whose media waits to be asked for", () => {
    draw({ project: { ...project, audioMediaStrategy: "manual" } as unknown as ProjectRecord })
    expect(screen.getByTestId(`take-row-wave-${OLD.audioId}`)).toBeInTheDocument()
    expect(loadPeaks).not.toHaveBeenCalled()
  })

  it("says how a recording compares with the text, and asks nothing of a generated take", () => {
    draw()
    expect(screen.getByTestId(`take-verdict-${OLD.audioId}`)).toHaveTextContent("2 words differ")
    expect(screen.queryByTestId(`take-verdict-${GEN.audioId}`)).toBeNull()
  })

  it("says a recording nobody transcribed is not transcribed", () => {
    draw({ timingsFor: () => undefined })
    expect(screen.getByTestId(`take-verdict-${OLD.audioId}`)).toHaveTextContent("Not transcribed")
  })

  // Sam, 2026-09-29: not hover-only — on every row, as in the recorder.
  it("keeps rename, remove noise and delete on every row, all the time", () => {
    draw()
    const row = screen.getByTestId(`take-row-${OLD.audioId}`)
    for (const name of ["Rename", "Remove", "Delete"]) {
      const b = [...row.querySelectorAll("button")].find((el) => el.getAttribute("aria-label")?.startsWith(name))
      expect(b, name).toBeDefined()
      expect(b!.className).not.toContain("opacity-0")
    }
  })

  it("uses a take the same way the recorder does — a generated one empties the recording slot", async () => {
    draw()
    fireEvent.click(screen.getByTestId(`take-row-${GEN.audioId}`).querySelector('button[aria-label="Use this take"]')!)
    await vi.waitFor(() => expect(emitDeselect).toHaveBeenCalledTimes(1))
    expect(emitSelect.mock.calls[0][0]).toMatchObject({ audioId: GEN.audioId, slot: "generatedVoice" })
    expect(emitDeselect.mock.calls[0][0]).toMatchObject({ slot: "recording" })
  })

  it("shows the note under the list", () => {
    draw({ note: <p>Using another take changes what 2 other lines play too.</p> })
    expect(screen.getByText("Using another take changes what 2 other lines play too.")).toBeInTheDocument()
  })

  it("reads no take history of its own when the caller passes it", () => {
    draw({ history: new Map() })
    expect(driftCalls.every((c) => c.enabled === false)).toBe(true)
  })
})
