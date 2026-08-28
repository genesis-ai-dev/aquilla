// What the audio card says when a file has tracks beyond the four it starts
// with. (AQU-646 stage 4, 2026-08-26)
//
// Sam set the conditions precisely: per line is the multi-track deliverable and
// the ONLY one; by character stays the default row's; and wherever a file
// carries added tracks, by character must say so — "a small subtle warning
// about those tracks not being exported with this selection".
//
// The gating half matters just as much and is easier to miss: the audio card
// decided a file had "nothing to export" by reading only the default track's
// two slots, so a file whose recordings live entirely on an added track offered
// no audio export at all — and "per line carries the new tracks" would have
// been a promise you could not reach from the dialog.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"
import type { TimelineTrack } from "@/lib/timeline/tracks"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))

import { useProjectCells } from "@/hooks/useProjectCells"

const mockProjectCells = vi.mocked(useProjectCells)

function plain(id: string): CellData {
  return {
    id, fileId: "f1", original: "source", translated: "translated",
    context: "", group: "", startTime: 1, endTime: 2,
  } as CellData
}

/** A take on the DEFAULT dub row. */
const recorded = (id: string, startTime: number): CellData =>
  ({
    ...plain(id), startTime, endTime: startTime + 1,
    selectedAudioId: `take-${id}`,
    attachments: { [`take-${id}`]: { url: `frontier-audio://take-${id}.wav`, type: "audio" } },
  }) as CellData

/** A take on an ADDED track — its slot is the track's id. */
const onTrack = (id: string, startTime: number, trackId: string): CellData =>
  ({
    ...plain(id), startTime, endTime: startTime + 1,
    selectedBySlot: { [trackId]: `t-${id}` },
    attachments: { [`t-${id}`]: { url: `frontier-audio://t-${id}.wav`, type: "audio" } },
  }) as CellData

const track = (id: string, name: string, kind: TimelineTrack["kind"]) =>
  ({ id, kind, name, order: 0 }) as unknown as TimelineTrack

const DERIVED = [
  track("source-subtitles", "Source text", "source-subtitles"),
  track("target-subtitles", "Target text", "target-subtitles"),
  track("source-audio", "Source audio", "source-audio"),
  track("target-audio", "Target audio", "target-audio"),
]

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "p1",
  projectName: "Demo project",
  activeFileId: "f1",
  activeFileName: "episode.vtt",
  // THE AUDIO CARD ONLY EXISTS ON A DUBBING FILE, and that is keyed on the
  // import type alone. Left as null, the whole card — the mode radios, the
  // notice, the Export button beside them — never renders, and every assertion
  // below would pass or fail for reasons that have nothing to do with tracks.
  activeFileType: "vtt",
  projectFiles: [{ id: "f1", name: "episode.vtt", type: "vtt" }],
  targetLanguage: "es",
  getToken: async () => null,
}

beforeEach(() => {
  vi.clearAllMocks()
  // THE DIALOG REMEMBERS ITS MODE PER USER AND PROJECT, in localStorage, and
  // these tests all share one project id — so without this each case inherits
  // whatever the previous one left selected, and a test asserting the DEFAULT
  // mode passes or fails on test order (2026-08-27).
  try {
    localStorage.removeItem("aq.exportdlg.v1")
  } catch {
    /* private mode — nothing was persisted either */
  }
  mockProjectCells.mockReturnValue({
    files: [], isLoading: false, isTruncated: false,
  } as ReturnType<typeof useProjectCells>)
})

const openAudioCard = () => {
  const card = screen.getByTestId("export-audio-card") as HTMLDetailsElement
  if (!card.open) fireEvent.click(card.querySelector("summary")!)
}
const note = () => screen.queryByTestId("export-audio-added-tracks-note")
/** THE AUDIO CARD'S OWN BUTTON, which is "Export audio".
 *
 *  Not `/^Export$/` — that matches the dialog's generic bottom button, which
 *  lives outside this card and is enabled for reasons having nothing to do with
 *  audio. Asserting on it made three of these tests pass while the thing they
 *  described was broken, and kept passing when the fix was reverted. */
const exportAudioButton = () => screen.getByRole("button", { name: /Export audio/i })

describe("the by-character notice", () => {
  // THE CONDITION SAM SPECIFIED, in his words: anything beyond the four
  // default source/target pairs.
  it("is absent on a file with only the four derived tracks", () => {
    render(<ExportDialog {...BASE_PROPS} cells={[recorded("s1", 5)]} timelineTracks={DERIVED} />)
    openAudioCard()
    expect(note()).toBeNull()
  })

  it("appears as soon as one audio track has been added", () => {
    render(
      <ExportDialog
        {...BASE_PROPS} cells={[recorded("s1", 5)]}
        timelineTracks={[...DERIVED, track("trk-es", "Spanish", "audio")]}
      />,
    )
    openAudioCard()
    expect(note()).toBeInTheDocument()
    expect(note()).toHaveTextContent(/Export by line/i)
  })

  // "Tracks that have been added" — existence, not content. A track somebody
  // made and has not recorded onto yet is still a track this export omits, and
  // finding that out after the zip arrives is the whole failure being avoided.
  it("appears for an added track nobody has recorded onto yet", () => {
    render(
      <ExportDialog
        {...BASE_PROPS} cells={[recorded("s1", 5)]}
        timelineTracks={[...DERIVED, track("trk-es", "Spanish", "audio")]}
      />,
    )
    openAudioCard()
    expect(note()).toBeInTheDocument()
  })

  // Sam's own ruling read back: "folders are not tracks." A folder holds no
  // takes, so warning that one will not be exported is noise about a thing
  // that could never have been in the zip.
  it("is not triggered by a folder", () => {
    render(
      <ExportDialog
        {...BASE_PROPS} cells={[recorded("s1", 5)]}
        timelineTracks={[...DERIVED, track("grp", "Dubs", "folder")]}
      />,
    )
    openAudioCard()
    expect(note()).toBeNull()
  })

  // A notice, not a gate (Sam: "small subtle warning"). By character is still
  // the right export for most of these files.
  it("does not disable anything", () => {
    render(
      <ExportDialog
        {...BASE_PROPS} cells={[recorded("s1", 5)]}
        timelineTracks={[...DERIVED, track("trk-es", "Spanish", "audio")]}
      />,
    )
    openAudioCard()
    expect(exportAudioButton()).toBeEnabled()
  })
})

describe("a file whose recordings are ONLY on an added track", () => {
  const props = {
    ...BASE_PROPS,
    cells: [onTrack("s1", 5, "trk-es")],
    timelineTracks: [...DERIVED, track("trk-es", "Spanish", "audio")],
  }

  // Without slot-aware gating this button is dead, on a file that plainly has
  // recordings and a per-line export that would write them.
  it("still offers the audio export", () => {
    render(<ExportDialog {...props} />)
    openAudioCard()
    expect(exportAudioButton()).toBeEnabled()
  })

  // …and the same file with the takes removed must NOT offer it, or the test
  // above proves only that the button is always on.
  it("refuses when there is genuinely nothing anywhere", () => {
    render(<ExportDialog {...props} cells={[plain("s1")]} />)
    openAudioCard()
    expect(exportAudioButton()).toBeDisabled()
  })

  it("still shows the notice, because by character would write nothing", () => {
    render(<ExportDialog {...props} />)
    openAudioCard()
    expect(note()).toBeInTheDocument()
  })

  // The by-character PREVIEW describes the by-character deliverable, which is
  // deliberately default-row-only — so it correctly reports no lines here. It
  // must not start counting takes that export will not contain.
  it("does not pretend by character will include them", () => {
    render(<ExportDialog {...props} />)
    openAudioCard()
    expect(screen.queryByText(/1 line/)).toBeNull()
  })

  // …BUT IT MUST NOT CLAIM THE FILE IS EMPTY EITHER (2026-08-27). The preview
  // is default-row-only, so "Nothing is recorded yet" was literally false here
  // — sitting one line from a button that, pressed in by-character mode, then
  // refused with "No recordings found in this file".
  it("says what is true: nothing on the main track, takes on an added one", () => {
    render(<ExportDialog {...props} />)
    openAudioCard()
    expect(screen.queryByText(/Nothing is recorded yet/)).toBeNull()
    expect(screen.getByText(/1 take is on an added track/)).toBeInTheDocument()
  })

  // Sam, 2026-08-27: open on the mode that can see them. The remembered mode is
  // validated against what this file can produce, the same way the remembered
  // fold format is validated against the formats on offer.
  it("opens on By line, the mode that can actually export them", async () => {
    render(<ExportDialog {...props} />)
    openAudioCard()
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /By line/ })).toBeChecked()
    })
    expect(screen.getByRole("radio", { name: /By character/ })).not.toBeChecked()
  })

  // A FALLBACK, NOT AN OVERRIDE: a file the default row CAN export keeps
  // by character, which is the default and the right export for most files.
  it("leaves By character alone when the main track has recordings", async () => {
    render(<ExportDialog {...props} cells={[recorded("s1", 5), onTrack("s2", 9, "trk-es")]} />)
    openAudioCard()
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /By character/ })).toBeChecked()
    })
  })
})
