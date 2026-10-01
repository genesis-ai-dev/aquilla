import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ImportDialog } from "./ImportDialog"

vi.mock("@/lib/import/youtube-caption-commit", () => ({
  createYouTubeCaptionCommit: vi.fn(),
}))

describe("ImportDialog YouTube navigation", () => {
  it("opens the link and caption export form", async () => {
    render(<ImportDialog open onOpenChange={vi.fn()}
      projectId="p1" username="dev" sourceLanguage="en"
      targetLanguage="fr" getToken={async () => "token"}
      onImported={vi.fn()} />)
    fireEvent.click(await screen.findByText("YouTube video and captions"))
    expect(await screen.findByLabelText("YouTube video link"))
      .toBeInTheDocument()
    expect(screen.getByLabelText("Your caption export"))
      .toBeInTheDocument()
  })
})
