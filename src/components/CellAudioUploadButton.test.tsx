// AQU-513: per-cell audio-file upload button. Verifies the upload handler
// reuses the SAME path the mic recorder uses (AudioRecordingModal.save):
// uploadCellAudio → emitCellAudioAttach(slot: "recording") →
// injectOptimisticAudioAttachment — so `hasAudio` flips before the server
// round-trip, matching the mic recorder's behavior.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { CellAudioUploadButton } from "./CellAudioUploadButton"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { LOCALE_STORAGE_KEY } from "@/lib/i18n/store"
import { CATALOGS } from "@/lib/i18n/messages"
import { translate } from "@/lib/i18n/translate"

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

// Round 6: the duration probe never resolves under happy-dom (media metadata
// doesn't load) — stub it so the attach proceeds immediately with a duration.
vi.mock("@/lib/import", () => ({
  probeDurationMsSafe: async () => 2500,
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
      // SUB-48: the overlay is tied to the attach event that will make it real.
      expect.anything(),
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

// ---------------------------------------------------------------------------
// AQU-510: the reason a translator reads is localized, not the raw throw.
//
// Producer → consumer, not two isolated halves: the real `attachAudioFileToCell`
// raises the failure, `toUserFacingError` classifies it, and this asserts on the
// text that actually lands in the popover. A unit test of the mapper plus a
// hand-built string would not have caught the bug — the mapper was already
// correct and already localized; the component simply never called it.
// ---------------------------------------------------------------------------
describe("CellAudioUploadButton — localized failure text (AQU-510)", () => {
  function setLocale(code: string) {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, code)
  }

  /**
   * The hidden picker, found by type rather than by label: its accessible name
   * is localized too, so `getByLabelText("Upload audio file")` finds nothing
   * once the locale is Burmese — which is the point of the feature.
   */
  function fileInput(): HTMLElement {
    const input = document.querySelector('input[type="file"]')
    if (!input) throw new Error("no file input rendered")
    return input as HTMLElement
  }

  beforeEach(() => {
    window.localStorage.clear()
  })

  /** The shape our fetch helpers throw: "<op> failed: HTTP <status> — <body>". */
  const RAW_403 =
    "uploadCellAudio failed: HTTP 403 — {\"error\":\"forbidden\",\"detail\":\"audio_write_denied for role viewer\"}"

  it("renders the Burmese sentence for an HTTP 403, and none of the raw body", async () => {
    setLocale("my")
    uploadCellAudio.mockRejectedValue(new Error(RAW_403))

    render(
      <I18nProvider>
        <CellAudioUploadButton {...PROPS} />
      </I18nProvider>,
    )
    selectFile(fileInput(), new File(["wav-bytes"], "recording.wav", { type: "audio/wav" }))

    const expected = translate(CATALOGS.my, "error.network.forbidden", { contextSuffix: "" }, "my")
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy())

    // The failure mode this ticket exists for: English/diagnostic text on screen.
    const shown = document.body.textContent ?? ""
    expect(shown).not.toContain("HTTP 403")
    expect(shown).not.toContain("audio_write_denied")
    expect(shown).not.toContain("forbidden")

    // Stronger than naming the strings we happen to expect: under a
    // non-Latin-script locale the reason must carry NO Latin letters at all.
    // A half-translated sentence — the catalogue's frame around an English noun
    // interpolated by the caller, which is what `toUserFacingError`'s `context`
    // argument produces — passes every assertion above and fails this one.
    expect(expected).not.toMatch(/[A-Za-z]/)
    const reason = screen.getByText(expected).textContent ?? ""
    expect(reason).not.toMatch(/[A-Za-z]/)
  })

  it("renders the Malay sentence for the same failure", async () => {
    setLocale("ms")
    uploadCellAudio.mockRejectedValue(new Error(RAW_403))

    render(
      <I18nProvider>
        <CellAudioUploadButton {...PROPS} />
      </I18nProvider>,
    )
    selectFile(fileInput(), new File(["wav-bytes"], "recording.wav", { type: "audio/wav" }))

    await waitFor(() =>
      expect(screen.getByText(/tidak mempunyai kebenaran/i)).toBeTruthy(),
    )
    expect(document.body.textContent ?? "").not.toContain("HTTP 403")
  })

  it("falls back to English rather than a raw key when the locale omits the string", async () => {
    // `zz` is not a registered locale, so the catalog lookup misses entirely —
    // the AC#4 path. English text, never a bare `error.network.*` key.
    setLocale("zz")
    uploadCellAudio.mockRejectedValue(new Error(RAW_403))

    render(
      <I18nProvider>
        <CellAudioUploadButton {...PROPS} />
      </I18nProvider>,
    )
    selectFile(fileInput(), new File(["wav-bytes"], "recording.wav", { type: "audio/wav" }))

    await waitFor(() =>
      expect(screen.getByText(/don't have permission to do that/i)).toBeTruthy(),
    )
    expect(document.body.textContent ?? "").not.toContain("error.network.")
  })
})
