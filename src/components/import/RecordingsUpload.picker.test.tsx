/**
 * AQU-2487 (import sweep, Nov 2): the recordings drop zone answers every drop.
 *
 * WHY: dropping an empty folder, or something the browser couldn't read, did
 * nothing and said nothing, so the drop zone looked broken.
 */
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { RecordingsPicker } from "./RecordingsUpload"

function dropZone(): HTMLElement {
  const zone = screen.getByText(/Drag recordings or a folder here/).parentElement
  if (!zone) throw new Error("drop zone not rendered")
  return zone
}

describe("RecordingsPicker — a drop with no files in it", () => {
  it("says no files were found, and clears that once files arrive", async () => {
    const onFiles = vi.fn()
    render(<RecordingsPicker fileName={null} languageLabel={null} onFiles={onFiles} />)

    fireEvent.drop(dropZone(), { dataTransfer: { items: [], files: [] } })
    expect(await screen.findByRole("alert")).toHaveTextContent("No files were found there.")
    expect(onFiles).not.toHaveBeenCalled()

    const take = new File(["x"], "Jonah 1.wav", { type: "audio/wav" })
    fireEvent.drop(dropZone(), { dataTransfer: { items: [], files: [take] } })
    await waitFor(() => expect(onFiles).toHaveBeenCalledOnce())
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("says so when the browser can't read what was dropped", async () => {
    const onFiles = vi.fn()
    render(<RecordingsPicker fileName={null} languageLabel={null} onFiles={onFiles} />)
    const unreadable = {
      kind: "file",
      webkitGetAsEntry: () => ({
        isFile: true,
        isDirectory: false,
        fullPath: "/gone.wav",
        file: (_ok: (file: File) => void, fail: (error: Error) => void) => fail(new Error("NotFoundError")),
      }),
    }
    fireEvent.drop(dropZone(), { dataTransfer: { items: [unreadable], files: [] } })
    expect(await screen.findByRole("alert")).toHaveTextContent("No files were found there.")
    expect(onFiles).not.toHaveBeenCalled()
  })
})
