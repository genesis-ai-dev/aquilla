// Import map M-caption-rules (Nov 2): a caption file met a 10 MB cap in Source
// cues, Subtitles and Characters but 95 MB in Upload files.
import { describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MAX_SOURCE_ARTIFACT_BYTES } from "../../../shared/import-contract"
import { MAX_CAPTION_FILE_BYTES } from "./caption-file-limit"
import { ImportSubtitlesDialog } from "@/components/timeline/ImportSubtitlesDialog"
import { ImportAudioVttDialog } from "@/components/timeline/ImportAudioVttDialog"
import { ImportCharactersDialog } from "@/components/timeline/ImportCharactersDialog"

/** A file that claims a size without allocating it. */
function sized(name: string, bytes: number, content = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n"): File {
  const file = new File([content], name, { type: "text/plain" })
  Object.defineProperty(file, "size", { value: bytes })
  return file
}

const ELEVEN_MB = 11 * 1024 * 1024

describe("one caption-file limit behind every door", () => {
  it("is Upload files' own limit", () => {
    expect(MAX_CAPTION_FILE_BYTES).toBe(MAX_SOURCE_ARTIFACT_BYTES)
  })

  it.each([
    ["Subtitles", () => render(<ImportSubtitlesDialog open textFileName="ep" onConfirm={vi.fn()} onCancel={vi.fn()} />), "import-subtitles-input", "ep.vtt"],
    ["Source cues", () => render(<ImportAudioVttDialog open replacing={false} textFileName="ep" onConfirm={vi.fn()} onReconcile={vi.fn()} onCancel={vi.fn()} />), "import-audio-vtt-input", "audio.vtt"],
    ["Characters", () => render(<ImportCharactersDialog open textFileName="ep" getCells={() => []} existingCount={0} onConfirm={vi.fn()} onCancel={vi.fn()} />), "import-characters-input", "cast.csv"],
  ])("%s takes an 11 MB file it refused before, and refuses one over the limit with the limit named", async (_door, open, inputId, name) => {
    const first = open()
    fireEvent.change(screen.getByTestId(inputId), { target: { files: [sized(name, ELEVEN_MB)] } })
    await waitFor(() => expect(screen.queryByTestId(inputId)).toBeNull())
    expect(screen.queryByText(/is larger than the/)).toBeNull()
    first.unmount()
    open()
    fireEvent.change(screen.getByTestId(inputId), { target: { files: [sized(name, MAX_CAPTION_FILE_BYTES + 1)] } })
    expect(await screen.findByText(`"${name}" is larger than the 95.0 MB limit for imports.`)).toBeInTheDocument()
  })
})
