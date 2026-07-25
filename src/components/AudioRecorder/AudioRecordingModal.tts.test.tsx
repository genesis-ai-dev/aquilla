// Round 8: the recording modal's Generate-TTS button — the clear
// "regenerate" counterpart to re-recording, right where recording lives.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "sam" }, loading: false }),
}))
vi.mock("@/hooks/useAudioRecorder", () => ({
  useAudioRecorder: () => ({
    state: { kind: "idle" },
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
  }),
}))
const attachmentsState = vi.hoisted(() => ({ byCellId: new Map<string, unknown>() }))
vi.mock("@/hooks/useFileAudioAttachments", () => ({
  useFileAudioAttachments: () => ({ byCellId: attachmentsState.byCellId, isLoading: false, revalidate: vi.fn() }),
  mergeCellsWithAudio: (cells: unknown[]) => cells,
}))
const generateCellVoice = vi.fn(async (..._args: unknown[]) => true)
vi.mock("@/lib/audio/voice-generate-helpers", () => ({
  generateCellVoice: (...args: unknown[]) => generateCellVoice(...args),
}))
vi.mock("@/lib/import", () => ({
  probeDurationMsSafe: async () => 1000,
}))

import { AudioRecordingModal } from "./AudioRecordingModal"

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord

const cellWith = (translated: string): CellData =>
  ({
    id: "c1", fileId: "f1", original: "hello", translated,
    medium: "media", startTime: 0, endTime: 5,
  }) as unknown as CellData

function renderModal(cell: CellData) {
  return render(
    <AudioRecordingModal
      open
      project={project}
      cells={[cell]}
      activeCellId="c1"
      username="sam"
      onActiveCellChange={() => {}}
      onClose={() => {}}
    />,
  )
}

describe("AudioRecordingModal — takes strip contents", () => {
  beforeEach(() => {
    attachmentsState.byCellId = new Map()
  })

  it("the imported SOURCE clip (fileId-seeded) never appears as a take", () => {
    const att = (audioId: string) => ({
      audioId, url: `frontier-audio://${audioId}`, slot: "recording", mimeType: "audio/mpeg",
      voiceId: null, referenceAudioId: null, durationMs: 4000,
      trimStartMs: null, trimEndMs: null, label: "Take 1",
    })
    attachmentsState.byCellId = new Map([
      ["c1", {
        attachments: {
          "audio-f1-100-clip.mp3": { ...att("audio-f1-100-clip.mp3"), label: null },
          "audio-c1-200-take.webm": att("audio-c1-200-take.webm"),
        },
        selectedAudioId: "audio-c1-200-take.webm",
        selectedGeneratedVoiceAudioId: null,
        audioTimings: {},
      }],
    ])
    renderModal(cellWith("bonjour"))
    expect(screen.getByTestId("take-row-audio-c1-200-take.webm")).toBeInTheDocument()
    expect(screen.queryByTestId("take-row-audio-f1-100-clip.mp3")).toBeNull()
    expect(screen.getByText("Takes (1)")).toBeInTheDocument()
  })
})

describe("AudioRecordingModal — Generate TTS (round 8)", () => {
  beforeEach(() => generateCellVoice.mockClear())

  it("renders beside Start and is disabled without a translation", () => {
    renderModal(cellWith(""))
    const btn = screen.getByTestId("rec-generate-tts")
    expect(btn).toBeDisabled()
    expect(screen.getByRole("button", { name: /Start/ })).toBeInTheDocument()
  })

  it("generates durably with the modal's project/cell/session/username", async () => {
    renderModal(cellWith("bonjour"))
    const btn = screen.getByTestId("rec-generate-tts")
    expect(btn).toBeEnabled()
    fireEvent.click(btn)
    await waitFor(() => expect(generateCellVoice).toHaveBeenCalledTimes(1))
    const [args] = generateCellVoice.mock.calls[0] as unknown as [{ project: ProjectRecord; cell: CellData; username: string }]
    expect(args.project.id).toBe("p1")
    expect(args.cell.id).toBe("c1")
    expect(args.username).toBe("sam")
  })
})
