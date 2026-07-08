// AQU-513: per-cell audio-file upload button. Verifies the upload handler
// reuses the SAME path the mic recorder uses (AudioRecordingModal.save):
// uploadCellAudio → emitCellAudioAttach(slot: "recording") →
// injectOptimisticAudioAttachment — so `hasAudio` flips before the server
// round-trip, matching the mic recorder's behavior.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { CellAudioUploadButton } from "./CellAudioUploadButton"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "tok", username: "wendy" },
    loading: false,
  }),
}))

const uploadCellAudio = vi.fn()
const deleteCellAudio = vi.fn()
vi.mock("@/lib/audio/upload", () => ({
  buildAudioId: (cellId: string) => `audio-${cellId}-123-abc`,
  uploadCellAudio: (...args: unknown[]) => uploadCellAudio(...args),
  deleteCellAudio: (...args: unknown[]) => deleteCellAudio(...args),
}))

const emitCellAudioAttach = vi.fn()
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: (...args: unknown[]) => emitCellAudioAttach(...args),
}))

const injectOptimisticAudioAttachment = vi.fn()
const notifyAudioAttachmentsChanged = vi.fn()
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  injectOptimisticAudioAttachment: (...args: unknown[]) => injectOptimisticAudioAttachment(...args),
  notifyAudioAttachmentsChanged: (...args: unknown[]) => notifyAudioAttachmentsChanged(...args),
}))

vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "sync-tok",
}))

const markProjectHasAudioDataSoon = vi.fn()
vi.mock("@/lib/audio/project-audio-state", () => ({
  markProjectHasAudioDataSoon: (...args: unknown[]) => markProjectHasAudioDataSoon(...args),
}))

const PROPS = {
  projectId: "proj-1",
  fileId: "file-1",
  cellId: "cell-1",
  username: "wendy",
}

function selectFile(input: HTMLElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true })
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

beforeEach(() => {
  vi.clearAllMocks()
  uploadCellAudio.mockResolvedValue({
    audioId: "audio-cell-1-123-abc",
    ext: "wav",
    url: "frontier-audio://audio-cell-1-123-abc.wav",
    sizeBytes: 1234,
  })
  emitCellAudioAttach.mockResolvedValue("event-1")
})

describe("CellAudioUploadButton", () => {
  it("selecting a wav file uploads then attaches with slot recording and injects the optimistic attachment", async () => {
    render(<CellAudioUploadButton {...PROPS} />)
    const input = screen.getByLabelText("Upload audio file", { selector: "input" })
    const file = new File(["wav-bytes"], "recording.wav", { type: "audio/wav" })

    selectFile(input, file)

    await waitFor(() => expect(emitCellAudioAttach).toHaveBeenCalled())

    expect(uploadCellAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        fileId: "file-1",
        audioId: "audio-cell-1-123-abc",
        ext: "wav",
        blob: file,
      }),
    )

    expect(emitCellAudioAttach).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        fileId: "file-1",
        cellId: "cell-1",
        audioId: "audio-cell-1-123-abc.wav",
        url: "frontier-audio://audio-cell-1-123-abc.wav",
        slot: "recording",
        mimeType: "audio/wav",
        author: "wendy",
      }),
    )

    expect(injectOptimisticAudioAttachment).toHaveBeenCalledWith(
      "file-1",
      "cell-1",
      expect.objectContaining({
        audioId: "audio-cell-1-123-abc.wav",
        url: "frontier-audio://audio-cell-1-123-abc.wav",
        slot: "recording",
      }),
    )
    expect(notifyAudioAttachmentsChanged).toHaveBeenCalledWith("file-1")
    expect(deleteCellAudio).not.toHaveBeenCalled()
  })

  it("selecting an mp3 file derives the mp3 extension from the filename", async () => {
    render(<CellAudioUploadButton {...PROPS} />)
    const input = screen.getByLabelText("Upload audio file", { selector: "input" })
    const file = new File(["mp3-bytes"], "phone-take.mp3", { type: "audio/mpeg" })

    selectFile(input, file)

    await waitFor(() => expect(uploadCellAudio).toHaveBeenCalled())
    expect(uploadCellAudio).toHaveBeenCalledWith(
      expect.objectContaining({ ext: "mp3", blob: file }),
    )
  })

  it("cleans up the orphaned R2 object when the attach event fails", async () => {
    emitCellAudioAttach.mockRejectedValueOnce(new Error("attach failed"))
    render(<CellAudioUploadButton {...PROPS} />)
    const input = screen.getByLabelText("Upload audio file", { selector: "input" })
    const file = new File(["wav-bytes"], "recording.wav", { type: "audio/wav" })

    selectFile(input, file)

    await waitFor(() => expect(deleteCellAudio).toHaveBeenCalled())
    expect(injectOptimisticAudioAttachment).not.toHaveBeenCalled()
    await screen.findByText("attach failed")
  })

  it("clicking the rail button opens the hidden file picker", () => {
    render(<CellAudioUploadButton {...PROPS} />)
    const input = screen.getByLabelText("Upload audio file", { selector: "input" }) as HTMLInputElement
    const clickSpy = vi.spyOn(input, "click")
    fireEvent.click(screen.getByRole("button", { name: "Upload audio file" }))
    expect(clickSpy).toHaveBeenCalled()
  })
})
