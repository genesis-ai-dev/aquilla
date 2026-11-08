// AQU-646: this replaced a `window.prompt`, which validated nothing — the local
// QA project ended up with a paragraph of English prose stored as its video URL,
// and the app rendered it as a black rectangle with no way to tell why.
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { LinkVideoUrlDialog, isLinkableVideoUrl } from "./LinkVideoUrlDialog"

function renderDialog(currentUrl: string | null = null) {
  const handlers = { onSave: vi.fn(), onCancel: vi.fn() }
  render(<LinkVideoUrlDialog open currentUrl={currentUrl} {...handlers} />)
  return handlers
}

describe("isLinkableVideoUrl", () => {
  it("accepts what a <video src> can actually fetch", () => {
    expect(isLinkableVideoUrl("https://cdn.example.com/ep.mp4")).toBe(true)
    expect(isLinkableVideoUrl("http://127.0.0.1:5173/ep.webm")).toBe(true)
    expect(isLinkableVideoUrl("blob:https://app/1234")).toBe(true)
  })

  it("rejects prose, blanks and non-fetchable schemes", () => {
    expect(isLinkableVideoUrl("")).toBe(false)
    expect(isLinkableVideoUrl("   ")).toBe(false)
    expect(isLinkableVideoUrl("If a project is in free timing and a contributor…")).toBe(false)
    expect(isLinkableVideoUrl("file:///Users/me/ep.mp4")).toBe(false)
    expect(isLinkableVideoUrl("javascript:alert(1)")).toBe(false)
  })
})

describe("LinkVideoUrlDialog", () => {
  it("saves a valid address", () => {
    const h = renderDialog()
    fireEvent.change(screen.getByTestId("link-video-url-input"), {
      target: { value: "  https://cdn/ep.mp4  " },
    })
    fireEvent.click(screen.getByTestId("link-video-save"))
    expect(h.onSave).toHaveBeenCalledWith("https://cdn/ep.mp4")
  })

  it("will not save junk, and says why", () => {
    const h = renderDialog()
    fireEvent.change(screen.getByTestId("link-video-url-input"), { target: { value: "not a url" } })
    expect(screen.getByTestId("link-video-url-error")).toBeInTheDocument()
    expect(screen.getByTestId("link-video-save")).toBeDisabled()
    fireEvent.click(screen.getByTestId("link-video-save"))
    expect(h.onSave).not.toHaveBeenCalled()
  })

  it("prefills the current link and can clear it", () => {
    const h = renderDialog("https://cdn/old.mp4")
    expect(screen.getByTestId("link-video-url-input")).toHaveValue("https://cdn/old.mp4")
    fireEvent.click(screen.getByTestId("link-video-clear"))
    expect(h.onSave).toHaveBeenCalledWith(null)
  })

  it("offers no way to clear a link that does not exist yet", () => {
    renderDialog(null)
    expect(screen.queryByTestId("link-video-clear")).toBeNull()
  })

  it("cancels without saving", () => {
    const h = renderDialog("https://cdn/old.mp4")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(h.onCancel).toHaveBeenCalledTimes(1)
    expect(h.onSave).not.toHaveBeenCalled()
  })
})

// Import map D#14: for an imported film the dialog was filled with its internal
// `frontier-audio://` address, which its own check rejected, so Save stayed
// disabled until the person typed something else.
describe("LinkVideoUrlDialog: an imported film", () => {
  function renderImported() {
    const handlers = { onSave: vi.fn(), onCancel: vi.fn() }
    render(<LinkVideoUrlDialog open currentUrl="frontier-audio://audio-f1-123.mov"
      filmName="Episode 101.mov" {...handlers} />)
    return handlers
  }

  it("names the film and never shows its internal address", () => {
    renderImported()
    expect(screen.getByTestId("link-video-imported")).toHaveTextContent("This file's film is Episode 101.mov")
    expect(screen.getByTestId("link-video-url-input")).toHaveValue("")
    expect(document.body.textContent).not.toContain("frontier-audio")
  })

  it("saving with the field still empty keeps the film", () => {
    const h = renderImported()
    fireEvent.click(screen.getByTestId("link-video-save"))
    expect(h.onSave).not.toHaveBeenCalled()
    expect(h.onCancel).toHaveBeenCalledTimes(1)
  })

  it("says clearing takes the picture only, and clears it", () => {
    const h = renderImported()
    expect(screen.getByText(/Its sound stays as the file's Source audio/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("link-video-clear"))
    expect(h.onSave).toHaveBeenCalledWith(null)
  })

  it("can switch to a linked film", () => {
    const h = renderImported()
    fireEvent.change(screen.getByTestId("link-video-url-input"), { target: { value: "https://cdn/ep.mp4" } })
    fireEvent.click(screen.getByTestId("link-video-save"))
    expect(h.onSave).toHaveBeenCalledWith("https://cdn/ep.mp4")
  })
})
