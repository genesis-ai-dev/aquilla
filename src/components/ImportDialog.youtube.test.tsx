import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ImportDialog } from "./ImportDialog"

vi.mock("@/lib/import/youtube-caption-commit", () => ({
  createYouTubeCaptionCommit: vi.fn(),
}))

describe("ImportDialog YouTube navigation", () => {
  it("puts Upload files before YouTube", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()}
      projectId="p1" username="dev" sourceLanguage="en" targetLanguage="fr"
      getToken={async () => "token"}
      onImported={vi.fn()} />)
    const upload = await screen.findByRole("button", { name: /^Upload files/i })
    const youtube = screen.getByRole("button", { name: /^YouTube/i })
    expect(upload.compareDocumentPosition(youtube) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })
  it("opens the link and caption export form", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()}
      projectId="p1" username="dev" sourceLanguage="en"
      targetLanguage="fr" getToken={async () => "token"}
      onImported={vi.fn()} />)
    fireEvent.click(await screen.findByText("YouTube video"))
    expect(await screen.findByLabelText("YouTube video link"))
      .toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Import a caption export"))
    expect(screen.getByLabelText("Your caption export"))
      .toBeInTheDocument()
  })
})
