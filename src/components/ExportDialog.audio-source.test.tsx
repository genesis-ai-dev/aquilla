// Which cells the audio export reads from. (AQU-646, 2026-08-18)
//
// Sam: "I get 'No recordings found in this file, so there is nothing to
// export' despite there definitely being target audio."
//
// This has now been the same bug twice, in two different disguises, and both
// times the export was pointed at cells that could not possibly carry a take:
//
//   1. The SUBTITLE rows, after stage 4 moved recording onto the audio cues.
//      Fixed by passing the cue sibling…
//   2. …but passing the RAW read of that sibling. Attachments and
//      `selectedAudioId` arrive only through `mergeCellsWithAudio`, so every
//      cue still looked take-less and the export went on finding nothing.
//
// Two further shapes are real and were never covered: the sibling reads as an
// empty array while it is still loading (the hook documents that state), and a
// file with no sibling at all carries its takes on its own cells. So the rule
// under test is not "prefer the sibling" but "use whichever array actually has
// a recording in it".

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"

const mockProjectCells = vi.mocked(useProjectCells)

/** A line with no recording on it. */
function plain(id: string): CellData {
  return {
    id,
    fileId: "f1",
    original: "source",
    translated: "translated",
    context: "",
    group: "",
    startTime: 1,
    endTime: 2,
  } as CellData
}

/** A line as it looks AFTER `mergeCellsWithAudio` — the only shape that can be
 *  exported. */
function recorded(id: string, startTime: number): CellData {
  return {
    ...plain(id),
    startTime,
    endTime: startTime + 1,
    selectedAudioId: `take-${id}`,
    attachments: { [`take-${id}`]: { url: `frontier-audio://take-${id}.wav`, type: "audio" } },
  } as CellData
}

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "p1",
  projectName: "Demo project",
  activeFileId: "f1",
  activeFileName: "episode.vtt",
  activeFileType: null,
  projectFiles: [{ id: "f1", name: "episode.vtt", type: "vtt" }],
  targetLanguage: "es",
  getToken: async () => null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
    revalidate: vi.fn(),
    applyOptimisticTargetEdit: vi.fn(),
  } as ReturnType<typeof useProjectCells>)
})

/** Open the format list and choose the audio export. */
function chooseAudioByCharacter() {
  fireEvent.click(screen.getByText("Audio by character"))
}

describe("the audio export finds the takes wherever they live", () => {
  it("uses the cue sibling when it carries the recordings", async () => {
    render(
      <ExportDialog
        {...BASE_PROPS}
        cells={[plain("s1"), plain("s2")]}
        audioCells={[recorded("q1", 10), recorded("q2", 20)]}
      />,
    )
    chooseAudioByCharacter()
    // The preview counts what will be exported, from the same array the export
    // reads — so it is the cheapest proof of which one was chosen.
    expect(await screen.findByText(/2 lines/)).toBeInTheDocument()
  })

  it("uses the file's OWN cells when there is no cue sibling", async () => {
    // An audio-first import has no sibling; its takes hang off its own rows.
    render(
      <ExportDialog {...BASE_PROPS} cells={[recorded("s1", 5)]} audioCells={undefined} />,
    )
    chooseAudioByCharacter()
    expect(await screen.findByText(/1 line/)).toBeInTheDocument()
  })

  it("uses the file's own cells when the sibling is still loading", async () => {
    // THE EMPTY-ARRAY TRAP. `audioCells ?? cells` treats [] as an answer, and
    // the hook returns [] for a sibling whose cues have not arrived yet.
    render(<ExportDialog {...BASE_PROPS} cells={[recorded("s1", 5)]} audioCells={[]} />)
    chooseAudioByCharacter()
    expect(await screen.findByText(/1 line/)).toBeInTheDocument()
  })

  it("refuses honestly when nothing anywhere has a recording", async () => {
    render(<ExportDialog {...BASE_PROPS} cells={[plain("s1")]} audioCells={[plain("q1")]} />)
    chooseAudioByCharacter()
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    const status = await screen.findByRole("status")
    await waitFor(() => expect(status).toHaveTextContent(/nothing to export/i))
    expect(vi.mocked(downloadBlob)).not.toHaveBeenCalled()
  })

  it("never reports 'nothing to export' when the recordings are on the sibling", async () => {
    // The exact sentence Sam saw, and the exact arrangement that produced it.
    render(
      <ExportDialog
        {...BASE_PROPS}
        cells={[plain("s1"), plain("s2")]}
        audioCells={[recorded("q1", 10)]}
      />,
    )
    chooseAudioByCharacter()
    expect(screen.queryByText(/nothing to export/i)).not.toBeInTheDocument()
    expect(await screen.findByText(/1 line/)).toBeInTheDocument()
  })
})

// ── The preview stays readable on a real episode (Sam, 2026-08-18) ────────
//
// "The preview is a little bit messy. Could we please collapse everything that
// says 'nothing recorded yet' into a dropdown." An episode carries dozens of
// one-line parts nobody has recorded, and listing them all buried the handful
// of characters the export is actually about.

describe("the preview folds away what has not been recorded", () => {
  const many = () => {
    const cells = [recorded("q1", 10), recorded("q2", 20)]
    for (let i = 0; i < 6; i += 1) cells.push(plain(`u${i}`))
    return cells
  }
  const names = (c: CellData) => (c.id.startsWith("q") ? "JESUS" : `EXTRA ${c.id}`)

  it("lists only the characters that will produce a file", async () => {
    render(
      <ExportDialog {...BASE_PROPS} cells={[]} audioCells={many()} resolveCharacterName={names} />,
    )
    chooseAudioByCharacter()
    expect(await screen.findByText("JESUS")).toBeVisible()
    // The unrecorded ones are inside the closed disclosure — present in the
    // markup (so opening it costs no fetch) but not on screen.
    expect(screen.getByText("EXTRA u0")).not.toBeVisible()
  })

  it("counts the rest behind one line you can open", async () => {
    render(
      <ExportDialog {...BASE_PROPS} cells={[]} audioCells={many()} resolveCharacterName={names} />,
    )
    chooseAudioByCharacter()
    const fold = await screen.findByTestId("export-unrecorded")
    expect(fold).toHaveTextContent(/6 characters with nothing recorded yet/)
    fireEvent.click(screen.getByText(/6 characters with nothing recorded yet/))
    expect(screen.getByText("EXTRA u0")).toBeInTheDocument()
  })

  it("says so plainly when nothing at all has been recorded", async () => {
    render(
      <ExportDialog
        {...BASE_PROPS}
        cells={[]}
        audioCells={[plain("q1"), plain("q2")]}
        resolveCharacterName={() => "JESUS"}
      />,
    )
    chooseAudioByCharacter()
    expect(await screen.findByText(/Nothing is recorded yet/)).toBeInTheDocument()
  })
})

// ── Two shapes, one preview (Sam, 2026-08-18) ────────────────────────────
//
// codex-editor offers both, as separate choices: one track per character for
// whoever mixes the episode, one file per line for whoever reviews it. Aquilla
// had only the first.

describe("the second audio shape", () => {
  it("is offered beside the per-character one", () => {
    render(<ExportDialog {...BASE_PROPS} cells={[]} audioCells={[recorded("q1", 10)]} />)
    expect(screen.getByText("Audio by character")).toBeInTheDocument()
    expect(screen.getByText("Audio by line")).toBeInTheDocument()
  })

  it("shows the same preview, because it describes what is RECORDED", async () => {
    render(
      <ExportDialog
        {...BASE_PROPS}
        cells={[]}
        audioCells={[recorded("q1", 10)]}
        resolveCharacterName={() => "JESUS"}
      />,
    )
    fireEvent.click(screen.getByText("Audio by line"))
    expect(await screen.findByText("JESUS")).toBeVisible()
    expect(await screen.findByText(/1 line/)).toBeInTheDocument()
  })

  it("refuses honestly when there is nothing recorded", async () => {
    render(<ExportDialog {...BASE_PROPS} cells={[]} audioCells={[plain("q1")]} />)
    fireEvent.click(screen.getByText("Audio by line"))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    const status = await screen.findByRole("status")
    await waitFor(() => expect(status).toHaveTextContent(/nothing to export/i))
    expect(vi.mocked(downloadBlob)).not.toHaveBeenCalled()
  })
})
