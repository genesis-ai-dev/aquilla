// What the export dialog leads with, for a file that is being dubbed.
// (AQU-646, 2026-08-19)
//
// The featured export used to be keyed purely to file identity — a VTT went in,
// so a VTT was offered back — which gave a dubbing episode exactly the same top
// billing for its subtitles that a Bible project gives USFM, while the exports
// this workflow actually delivers sat in the fold beside TMX and plaintext.
//
// Sam's rule, stated in one sentence on purpose: if the file was imported as a
// VTT or an SRT, it is an episode being dubbed. Its audio and its subtitles are
// the deliverables, so they get the top of the dialog.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"

import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))

import { useProjectCells } from "@/hooks/useProjectCells"

const mockProjectCells = vi.mocked(useProjectCells)

function plain(id: string, startTime = 1): CellData {
  return {
    id, fileId: "f1", original: "source", translated: "translated",
    context: "", group: "", startTime, endTime: startTime + 1,
  } as CellData
}

function recorded(id: string, startTime: number): CellData {
  return {
    ...plain(id, startTime),
    selectedAudioId: `take-${id}`,
    attachments: { [`take-${id}`]: { url: `frontier-audio://take-${id}.wav`, type: "audio" } },
  } as CellData
}

const BASE = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "p1",
  projectName: "The Chosen",
  activeFileId: "f1",
  activeFileName: "episode.vtt",
  projectFiles: [{ id: "f1", name: "episode.vtt", type: "vtt" }],
  targetLanguage: "es",
  getToken: async () => null,
}

beforeEach(() => {
  vi.clearAllMocks()
  // The dialog remembers its last selection per project and user. Left over
  // between tests it would silently pre-open a section and make the
  // all-collapsed assertions pass or fail for the wrong reason.
  window.localStorage.clear()
  mockProjectCells.mockReturnValue({
    files: [], isLoading: false, isTruncated: false,
  } as ReturnType<typeof useProjectCells>)
})

/**
 * Open one of the three sections by clicking its heading.
 *
 * Everything is in the DOM whether a section is open or not (`<details>` keeps
 * its content mounted), so a test that reaches into a collapsed section still
 * FINDS what it is looking for — it just is not visible. That is why the
 * assertions below are split between presence and visibility depending on
 * which question they are really asking.
 */
const openSection = (name: RegExp | string) => fireEvent.click(screen.getByText(name))

const dubbing = (over: Record<string, unknown> = {}) =>
  render(
    <ExportDialog
      {...BASE}
      activeFileType="vtt"
      cells={[plain("s1"), plain("s2")]}
      audioCells={[recorded("q1", 10)]}
      resolveCharacterName={() => "JESUS"}
      {...over}
    />,
  )

describe("a dubbing file leads with its own deliverables", () => {
  it("features audio first, then the subtitles", () => {
    dubbing()
    const audio = screen.getByTestId("export-audio-card")
    const subs = screen.getByTestId("export-subtitle-card")
    expect(audio).toBeInTheDocument()
    expect(subs).toBeInTheDocument()
    // Order matters: the audio is what the work produces.
    expect(audio.compareDocumentPosition(subs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("offers the two audio shapes as one choice rather than two competing entries", () => {
    dubbing()
    const card = within(screen.getByTestId("export-audio-card"))
    expect(card.getByText("By character")).toBeInTheDocument()
    expect(card.getByText("By line")).toBeInTheDocument()
    expect(card.getByRole("button", { name: /Export audio/i })).toBeInTheDocument()
  })

  it("puts the recorded/unrecorded preview inside the card that acts on it", () => {
    dubbing()
    openSection("Audio")
    const card = within(screen.getByTestId("export-audio-card"))
    expect(card.getByText("JESUS")).toBeVisible()
  })

  it("says nothing is recorded and refuses to arm, rather than failing after the press", () => {
    // A button that leads to "there is nothing to export" is a worse answer
    // than a button that is plainly not available yet.
    dubbing({ audioCells: [plain("q1")] })
    const card = within(screen.getByTestId("export-audio-card"))
    expect(card.getByText(/Nothing is recorded yet/)).toBeInTheDocument()
    expect(card.getByRole("button", { name: /Export audio/i })).toBeDisabled()
  })

  it("keeps the subtitle round-trip, with its shape options on the card", () => {
    dubbing()
    openSection("VTT export")
    const card = within(screen.getByTestId("export-subtitle-card"))
    expect(card.getByRole("button", { name: /Download .*\.vtt/i })).toBeInTheDocument()
    expect(card.getByText(/Split overlapping cues/)).toBeInTheDocument()
  })
})

describe("the fold stops repeating what is featured", () => {
  const openFold = () => openSection("Export to another format")

  it("drops the featured formats from the list", () => {
    dubbing()
    openFold()
    // Offering them twice invites the two copies to drift.
    expect(screen.queryByRole("radio", { name: /Audio by character/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: /Audio by line/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: /^WEBVTT/i })).not.toBeInTheDocument()
  })

  it("leads with the sibling subtitle format and the metadata sheet", () => {
    dubbing()
    openFold()
    const radios = screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? "")
    const srt = radios.findIndex((l) => /SRT/i.test(l))
    const meta = radios.findIndex((l) => /Metadata/i.test(l))
    const tsv = radios.findIndex((l) => /TSV/i.test(l))
    expect(srt).toBeGreaterThanOrEqual(0)
    expect(srt).toBeLessThan(tsv)
    expect(meta).toBeLessThan(tsv)
  })

  it("mirrors for a file imported as SRT", () => {
    dubbing({ activeFileType: "srt", activeFileName: "episode.srt", projectFiles: [{ id: "f1", name: "episode.srt", type: "srt" }] })
    openFold()
    const radios = screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? "")
    // VTT is the sibling here, and SRT is the one featured above.
    expect(radios.some((l) => /WEBVTT/i.test(l))).toBe(true)
    expect(radios.some((l) => /^SRT/i.test(l))).toBe(false)
  })
})

describe("an sbv episode is a dubbing file too", () => {
  it("gets the same three sections as its VTT and SRT neighbours", () => {
    // The dialog carried its own `vtt || srt` check until 2026-08-20 and
    // missed `sbv` — the exact omission `isSubtitleImportFile` exists to stop
    // repeating. An sbv imports to the same timed cues as the other two.
    dubbing({
      activeFileType: "sbv",
      activeFileName: "episode.sbv",
      projectFiles: [{ id: "f1", name: "episode.sbv", type: "sbv" }],
    })
    expect(screen.getByTestId("export-audio-card")).toBeInTheDocument()
    expect(screen.getByTestId("export-fold")).toBeInTheDocument()
  })
})

describe("every other kind of project is untouched", () => {
  it("keeps the plain native card and leaves the audio exports in the fold", () => {
    render(
      <ExportDialog
        {...BASE}
        activeFileType={null}
        activeFileName="gen.txt"
        projectFiles={[{ id: "f1", name: "gen.txt", type: "txt" }]}
        cells={[recorded("s1", 5)]}
      />,
    )
    expect(screen.queryByTestId("export-audio-card")).not.toBeInTheDocument()
    expect(screen.queryByTestId("export-subtitle-card")).not.toBeInTheDocument()
    // An audio-first import has no cue sibling and still needs to reach these.
    expect(screen.getByRole("radio", { name: /Audio by character/i })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Audio by line/i })).toBeInTheDocument()
  })
})

// ── Anna's two exports (AQU-646, 2026-08-19) ─────────────────────────────
//
// She does not translate or dub. Her job is making sure the files are
// consistent — finding errors and resolving discrepancies — and until now her
// corrections lived in the app while her team kept working from the
// spreadsheets that still contained every one of them.

describe("the exports for the person who checks the files", () => {
  const openFold = () => fireEvent.click(screen.getByText("Export to another format"))

  it("offers the corrected sheets and the project report", () => {
    dubbing()
    openFold()
    expect(screen.getByRole("radio", { name: /Character sheets \(corrected\)/i })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Project report/i })).toBeInTheDocument()
  })

  it("puts them near the top, not below the general text formats", () => {
    dubbing()
    openFold()
    const radios = screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? "")
    const sheets = radios.findIndex((l) => /Character sheets/i.test(l))
    const report = radios.findIndex((l) => /Project report/i.test(l))
    const tmx = radios.findIndex((l) => /TMX/i.test(l))
    expect(sheets).toBeLessThan(tmx)
    expect(report).toBeLessThan(tmx)
  })

  it("refuses the sheets on a file with no audio cues, and says why", async () => {
    // One sheet is not a reconciliation. Better to explain that than to hand
    // over a workbook with an empty tab.
    dubbing({ audioCells: [] })
    openFold()
    fireEvent.click(screen.getByRole("radio", { name: /Character sheets/i }))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/no audio cues imported/i)
  })

  it("refuses the report when the project has no files to walk", async () => {
    dubbing({ reportFiles: [] })
    openFold()
    fireEvent.click(screen.getByRole("radio", { name: /Project report/i }))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/no subtitle files/i)
  })

  it("forces the report to project scope, since a one-file report is a lie", () => {
    // Name consistency only means anything ACROSS episodes: MARY in one and
    // MARY MAGDALENE in the next is invisible inside either file. So the scope
    // control stops offering "current file" the moment the report is chosen.
    dubbing()
    openFold()
    const wholeProject = () => screen.getByRole("tab", { name: /Whole project/i })
    expect(wholeProject()).not.toHaveAttribute("data-active")
    fireEvent.click(screen.getByRole("radio", { name: /Project report/i }))
    expect(wholeProject()).toHaveAttribute("data-active")
  })
})


// ── Three sections, one open at a time (Sam, 2026-08-20) ────────────────────
//
// "Let's say I click on 'audio' and it expands the area. If I then click on
// 'vtt export', then it would collapse the audio area and expand the vtt
// export area." One piece of state does the whole job: opening a section IS
// closing the others, so the two can never disagree.
//
// Note the assertions below check VISIBILITY, not presence. A `<details>`
// keeps its content in the DOM when closed — deliberately, so a half-typed
// filename survives being collapsed — which means `queryBy…` finds a closed
// section's contents just fine.

describe("the three sections open one at a time", () => {
  const isOpen = (testId: string) =>
    (screen.getByTestId(testId) as HTMLDetailsElement).open

  it("starts with all three collapsed", () => {
    dubbing()
    expect(isOpen("export-audio-card")).toBe(false)
    expect(isOpen("export-subtitle-card")).toBe(false)
    expect(isOpen("export-fold")).toBe(false)
  })

  it("opens the one that was clicked", () => {
    dubbing()
    openSection("Audio")
    expect(isOpen("export-audio-card")).toBe(true)
  })

  it("closes the open one when another is clicked", () => {
    dubbing()
    openSection("Audio")
    openSection("VTT export")
    expect(isOpen("export-audio-card")).toBe(false)
    expect(isOpen("export-subtitle-card")).toBe(true)
  })

  it("switches sections in ONE click, even when the browser echoes the close", () => {
    // THE BUG SAM HIT EVERY TIME (2026-08-20), and the reason the first cut of
    // these tests missed it entirely.
    //
    // In a real browser one click fires TWO toggle events: the clicked section
    // opens, and then React closes the previously-open one by changing its
    // `open` prop — which makes the browser fire THAT section's toggle too,
    // reporting false. Read as "a section was closed", the echo cancelled the
    // section just opened, so the first click only ever collapsed things and
    // the second click was what opened anything.
    //
    // jsdom does NOT fire toggle on a programmatic `open` change, so the echo
    // has to be dispatched by hand. Without this dispatch the test passes
    // against the broken code and is worth nothing.
    dubbing()
    openSection("Audio")
    const audio = screen.getByTestId("export-audio-card") as HTMLDetailsElement

    openSection("VTT export")
    expect(isOpen("export-subtitle-card")).toBe(true)

    // React has now set audio.open = false; the browser would announce it.
    expect(audio.open).toBe(false)
    fireEvent(audio, new Event("toggle", { bubbles: false }))

    // The echo must not take the newly-opened section down with it.
    expect(isOpen("export-subtitle-card")).toBe(true)
    expect(isOpen("export-audio-card")).toBe(false)
  })

  it("still closes on the echo when it is the open section reporting", () => {
    // The guard must not deafen the real case: a user clicking the open
    // section's own heading to shut it.
    dubbing()
    openSection("Audio")
    const audio = screen.getByTestId("export-audio-card") as HTMLDetailsElement
    audio.open = false
    fireEvent(audio, new Event("toggle", { bubbles: false }))
    expect(isOpen("export-audio-card")).toBe(false)
  })

  it("closes a section clicked a second time, leaving all three shut", () => {
    dubbing()
    openSection("Audio")
    openSection("Audio")
    expect(isOpen("export-audio-card")).toBe(false)
    expect(isOpen("export-subtitle-card")).toBe(false)
    expect(isOpen("export-fold")).toBe(false)
  })

  it("names the middle section for the format, and says SRT on an SRT file", () => {
    dubbing({
      activeFileType: "srt",
      activeFileName: "episode.srt",
      projectFiles: [{ id: "f1", name: "episode.srt", type: "srt" }],
    })
    expect(screen.getByText("SRT export")).toBeInTheDocument()
    expect(screen.queryByText("VTT export")).not.toBeInTheDocument()
  })
})

// ── The heard lines as their own subtitle file ──────────────────────────────
//
// The audio cues are a real second file: same film, same clock, carrying what
// was actually SAID rather than what it was translated to. Exporting them
// through the subtitle exporter gives a reviewer something to play against the
// picture — which is why the choice lives inside the VTT section rather than
// as its own format.

describe("subtitle VTT against audio VTT", () => {
  const withSibling = (over: Record<string, unknown> = {}) =>
    dubbing({ audioSiblingName: "episode.vtt · audio cues", ...over })

  it("offers the choice when there really is a sibling", () => {
    withSibling()
    openSection("VTT export")
    expect(screen.getByRole("radio", { name: /Subtitle VTT/i })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Audio VTT/i })).toBeInTheDocument()
  })

  it("does not offer it when no audio file was ever imported", () => {
    // THE ALIASING TRAP. `audioCells` falls back to this file's own rows when
    // there is no sibling, so an ungated choice would re-export the subtitles
    // under an "_audio" name and call it the heard lines.
    dubbing({ audioSiblingName: null })
    openSection("VTT export")
    expect(screen.queryByRole("radio", { name: /Audio VTT/i })).not.toBeInTheDocument()
  })

  it("names the download after the file it is really exporting", () => {
    withSibling()
    openSection("VTT export")
    expect(screen.getByRole("button", { name: /Download episode\.vtt/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: /Audio VTT/i }))
    expect(screen.getByRole("button", { name: /Download episode_audio\.vtt/i })).toBeInTheDocument()
  })

  it("drops the source-text option for the cues, which have no translation", () => {
    // A checkbox that visibly does nothing reads as broken.
    withSibling()
    openSection("VTT export")
    expect(screen.getByText(/Include the source text/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: /Audio VTT/i }))
    expect(screen.queryByText(/Include the source text/)).not.toBeInTheDocument()
    // The two that still mean something stay.
    expect(screen.getByText(/Split overlapping cues/)).toBeInTheDocument()
    expect(screen.getByText(/Leave out character names/)).toBeInTheDocument()
  })

  it("falls back to the subtitles when a remembered audio choice has no sibling", () => {
    // Someone exports the audio VTT on episode 101, then opens the dialog on a
    // file that never had an audio import. The remembered choice must not
    // strand them on an option that is not on screen.
    window.localStorage.setItem(
      "aq.exportdlg.v1",
      JSON.stringify([
        { userId: "local", projectId: "p1", state: { subtitleTarget: "audio" } },
      ]),
    )
    dubbing({ audioSiblingName: null })
    openSection("VTT export")
    expect(screen.getByRole("button", { name: /Download episode\.vtt/i })).toBeInTheDocument()
  })
})

// ── Remembering where you were (Sam, 2026-08-20) ────────────────────────────
//
// "It should remember the last thing that was selected. And then if it's
// closed and reopened, then we automatically go to the last selected export
// selection." Per project AND per user: a dubbing project is worked one way
// every time, and two people on one machine should not inherit each other's
// last click.

describe("what the dialog remembers", () => {
  /**
   * Render once and drive the SAME dialog through close-and-reopen, because
   * that is the real sequence: the component stays mounted between openings,
   * which is exactly why the restore happens on the `open` transition rather
   * than on mount.
   */
  const mounted = (over: Record<string, unknown> = {}) => {
    const props = {
      ...BASE,
      activeFileType: "vtt" as const,
      cells: [plain("s1"), plain("s2")],
      audioCells: [recorded("q1", 10)],
      resolveCharacterName: () => "JESUS",
      ...over,
    }
    const { rerender } = render(<ExportDialog {...props} open />)
    return {
      reopen: () => {
        rerender(<ExportDialog {...props} open={false} />)
        rerender(<ExportDialog {...props} open />)
      },
    }
  }
  const isOpen = (testId: string) => (screen.getByTestId(testId) as HTMLDetailsElement).open

  it("reopens on the section that was last used", () => {
    const { reopen } = mounted()
    openSection("Audio")
    reopen()
    expect(isOpen("export-audio-card")).toBe(true)
  })

  it("carries the inner choices across a close and reopen", () => {
    const { reopen } = mounted()
    openSection("VTT export")
    fireEvent.click(screen.getByText("Leave out character names"))
    reopen()
    expect(isOpen("export-subtitle-card")).toBe(true)
    expect(screen.getByRole("checkbox", { name: /Leave out character names/i })).toBeChecked()
  })

  it("reopens all-collapsed when that is how it was left", () => {
    const { reopen } = mounted()
    openSection("Audio")
    openSection("Audio")
    reopen()
    expect(isOpen("export-audio-card")).toBe(false)
    expect(isOpen("export-subtitle-card")).toBe(false)
    expect(isOpen("export-fold")).toBe(false)
  })

  it("keeps one user's choice away from another's", () => {
    window.localStorage.setItem(
      "aq.exportdlg.v1",
      JSON.stringify([{ userId: "anna", projectId: "p1", state: { section: "fold" } }]),
    )
    dubbing({ currentUsername: "sam" })
    expect(isOpen("export-fold")).toBe(false)
  })

  it("keeps one project's choice away from another's", () => {
    window.localStorage.setItem(
      "aq.exportdlg.v1",
      JSON.stringify([{ userId: "local", projectId: "other", state: { section: "fold" } }]),
    )
    dubbing()
    expect(isOpen("export-fold")).toBe(false)
  })

  it("restores a stored section for the matching user and project", () => {
    window.localStorage.setItem(
      "aq.exportdlg.v1",
      JSON.stringify([{ userId: "sam", projectId: "p1", state: { section: "fold" } }]),
    )
    dubbing({ currentUsername: "sam" })
    expect(isOpen("export-fold")).toBe(true)
  })

  it("opens fresh rather than throwing on a stored shape it does not recognise", () => {
    // A value from an older build, or one somebody hand-edited. Falling back
    // beats selecting a format that is no longer offered.
    window.localStorage.setItem(
      "aq.exportdlg.v1",
      JSON.stringify([
        { userId: "local", projectId: "p1", state: { section: "nonsense", foldFormat: "gone" } },
      ]),
    )
    dubbing()
    expect(isOpen("export-audio-card")).toBe(false)
    expect(isOpen("export-fold")).toBe(false)
  })

  it("survives localStorage being unreadable entirely", () => {
    window.localStorage.setItem("aq.exportdlg.v1", "{not json")
    dubbing()
    expect(screen.getByTestId("export-audio-card")).toBeInTheDocument()
  })
})
