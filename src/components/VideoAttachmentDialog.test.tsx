// AQU-820: VideoAttachmentDialog previously showed `err.message` from a
// failed storeVideoBlob() call (a raw, unlocalized IndexedDB/browser
// exception) instead of the already-translated common.uploadFailed fallback
// — the keyed message existed but never rendered. This asserts the keyed
// message wins even when the thrown error carries different text.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { VideoAttachmentDialog } from "./VideoAttachmentDialog"
import { storeVideoBlob } from "@/lib/video/video-store"
import type { VideoAttachment } from "@/lib/parsers/types"

vi.mock("@/lib/video/video-store", () => ({
  storeVideoBlob: vi.fn(),
  deleteVideoBlob: vi.fn(),
}))

const storeVideoBlobMock = vi.mocked(storeVideoBlob)

const EMPTY_ATTACHMENT: VideoAttachment = {}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("VideoAttachmentDialog upload failure", () => {
  it("shows the translated generic message, not the raw thrown error text", async () => {
    storeVideoBlobMock.mockRejectedValue(
      new Error("QuotaExceededError: the quota has been exceeded"),
    )

    render(
      <VideoAttachmentDialog
        open
        onOpenChange={() => {}}
        current={EMPTY_ATTACHMENT}
        onSave={() => {}}
      />,
    )

    fireEvent.click(screen.getByText("Choose file"))
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(["x"], "clip.mp4", { type: "video/mp4" })
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
      fireEvent.change(fileInput)
    })

    await waitFor(() => {
      expect(screen.getByText("Upload failed")).toBeInTheDocument()
    })
    expect(screen.queryByText(/QuotaExceededError/)).not.toBeInTheDocument()
  })
})
