// Importing the character spreadsheet. (AQU-646 stage 6)
//
// The dialog's job is to say what the file will DO before it does it, and to
// refuse the one case that would be catastrophic and silent: a sheet from the
// wrong episode, which would put hundreds of characters on lines they do not
// belong to. So the assertions are mostly about the summary being right and
// the refusal being unskippable.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { ImportCharactersDialog } from "./ImportCharactersDialog"

const HEADER = "ID,Source,endTime,startTime,timeStamp,Character Label,VTT_closest,Camera"
const row = (start: string, character: string, camera = "") =>
  `1,text,,${start},${start} --> 00:00:00.000,${character},,${camera}`

const CSV = (...rows: string[]) => [HEADER, ...rows].join("\n")

const cells = [
  { id: "c1", startTime: 10 },
  { id: "c2", startTime: 20 },
  { id: "c3", startTime: 30 },
]

async function pick(csv: string, over: Record<string, unknown> = {}) {
  const onConfirm = vi.fn()
  render(
    <ImportCharactersDialog
      open
      textFileName="ep101.vtt"
      cells={cells}
      existingCount={0}
      onConfirm={onConfirm}
      onCancel={() => {}}
      {...over}
    />,
  )
  const file = new File([csv], "characters.csv", { type: "text/csv" })
  fireEvent.change(screen.getByTestId("import-characters-input"), { target: { files: [file] } })
  return { onConfirm }
}

describe("what it will do, before it does it", () => {
  it("reports the assignment count and the size of the cast", async () => {
    const { onConfirm } = await pick(
      CSV(row("00:00:10.000", "JESUS. (On)"), row("00:00:20.000", "MARY (Off)")),
    )
    await waitFor(() =>
      expect(screen.getByTestId("import-characters-summary")).toHaveTextContent(
        "2 lines get a character",
      ),
    )
    expect(screen.getByTestId("import-characters-summary")).toHaveTextContent("2 people")
    fireEvent.click(screen.getByTestId("import-characters-confirm"))
    const [plan] = onConfirm.mock.calls[0]
    expect(plan.assignments).toEqual([
      { cellId: "c1", castName: "JESUS.", cameraState: "on", rowNumber: 2 },
      { cellId: "c2", castName: "MARY", cameraState: "off", rowNumber: 3 },
    ])
  })

  it("says how many rows are unspoken text and skipped", async () => {
    await pick(CSV(row("00:00:10.000", ""), row("00:00:20.000", "MARY")))
    await waitFor(() =>
      expect(screen.getByTestId("import-characters-summary")).toHaveTextContent(
        "1 rows have no character",
      ),
    )
  })

  it("says how many lines the sheet does not cover — which is fine", async () => {
    await pick(CSV(row("00:00:10.000", "JESUS.")))
    await waitFor(() =>
      expect(screen.getByTestId("import-characters-summary")).toHaveTextContent(
        "2 lines are not in the sheet",
      ),
    )
  })

  it("says when a row was matched by position rather than timestamp", async () => {
    // Sam's real file: two rows sit 84ms — two frames — after their line. The
    // neighbours pin them, so they are recovered, but the fact is worth saying
    // because it means the sheet and the subtitles disagree slightly.
    await pick(
      CSV(row("00:00:10.000", "A"), row("00:00:20.084", "B"), row("00:00:30.000", "C")),
    )
    await waitFor(() =>
      expect(screen.getByTestId("import-characters-drift")).toHaveTextContent(
        "matched by position",
      ),
    )
    expect(screen.queryByTestId("import-characters-mismatch")).not.toBeInTheDocument()
  })

  it("warns when the camera column and the embedded angle disagree", async () => {
    // Never happens in episode 101 — this is the tripwire for a future file
    // where the redundancy stops being redundant.
    await pick(CSV(row("00:00:10.000", "JESUS. (On)", "Off")))
    await waitFor(() =>
      expect(screen.getByTestId("import-characters-camera-warning")).toHaveTextContent(
        "the Camera column and the angle",
      ),
    )
  })
})

describe("the refusal", () => {
  it("REFUSES a sheet whose rows match no line, and says which row", async () => {
    // The wrong-episode signal. Assigning the few that happened to land would
    // be worse than doing nothing.
    const { onConfirm } = await pick(
      CSV(row("00:05:00.000", "JESUS."), row("00:06:00.000", "MARY")),
    )
    await waitFor(() =>
      expect(screen.getByTestId("import-characters-mismatch")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("import-characters-mismatch")).toHaveTextContent(
      "2 of this sheet's rows match no line",
    )
    expect(screen.getByTestId("import-characters-mismatch")).toHaveTextContent("starting at row 2")
    expect(screen.getByTestId("import-characters-confirm")).toBeDisabled()
    fireEvent.click(screen.getByTestId("import-characters-confirm"))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("refuses even when only ONE row is adrift", async () => {
    // Partial application is the trap: it looks like success and leaves the
    // file half-wrong.
    await pick(CSV(row("00:00:10.000", "JESUS."), row("00:09:99.000", "MARY")))
    await waitFor(() =>
      expect(screen.getByTestId("import-characters-mismatch")).toBeInTheDocument(),
    )
    expect(screen.queryByTestId("import-characters-summary")).not.toBeInTheDocument()
  })

  it("says so when the sheet has no character column at all", async () => {
    await pick("ID,Source,startTime\n1,text,00:00:10.000")
    await waitFor(() =>
      expect(screen.getByTestId("import-characters-nocolumn")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("import-characters-confirm")).toBeDisabled()
  })

  it("refuses an empty file", async () => {
    render(
      <ImportCharactersDialog
        open textFileName="ep101.vtt" cells={cells} existingCount={0}
        onConfirm={vi.fn()} onCancel={() => {}}
      />,
    )
    const file = new File([], "characters.csv", { type: "text/csv" })
    fireEvent.change(screen.getByTestId("import-characters-input"), { target: { files: [file] } })
    await waitFor(() =>
      expect(screen.getByTestId("import-characters-error")).toHaveTextContent("empty"),
    )
  })
})

describe("wording", () => {
  it("says Replace once lines already carry a character", () => {
    render(
      <ImportCharactersDialog
        open textFileName="ep101.vtt" cells={cells} existingCount={637}
        onConfirm={vi.fn()} onCancel={() => {}}
      />,
    )
    // Retitled when the dialog gained two ways to take a sheet back OFF:
    // "Replace the characters" was a door labelled with half of what is
    // behind it. The state now leads the description instead.
    expect(screen.getByText("Characters")).toBeInTheDocument()
    expect(screen.getByText(/637 subtitle lines carry a character/)).toBeInTheDocument()
  })

  it("says Import when none do", () => {
    render(
      <ImportCharactersDialog
        open textFileName="ep101.vtt" cells={cells} existingCount={0}
        onConfirm={vi.fn()} onCancel={() => {}}
      />,
    )
    expect(screen.getByText("Import characters")).toBeInTheDocument()
  })
})

// ── The other sheet ──────────────────────────────────────────────────────
//
// The client ships two character spreadsheets per episode, keyed to opposite
// sides of the same script. Either can be imported first. The button says which
// you meant; the dialog then checks the file against that and says so when they
// disagree, because "this sheet matches no line" is a true and useless message
// when the real answer is that it belongs under the other button.

const AUDIO_HEADER = "Line #,startTime,endTime,Character,Translation,Camera"
const audioRow = (start: string, character: string, text: string, camera = "") =>
  `10,${start},,${character},${text},${camera}`
const AUDIO_CSV = (...rows: string[]) => [AUDIO_HEADER, ...rows].join("\n")

const audioCues = [
  { id: "q1", startTime: 10, original: "Abba?" },
  { id: "q2", startTime: 20, original: "I can't sleep." },
  { id: "q3", startTime: 30, original: "Sit down." },
]

async function pickAudio(csv: string, over: Record<string, unknown> = {}) {
  const onConfirmAudio = vi.fn()
  render(
    <ImportCharactersDialog
      open
      textFileName="ep101.vtt"
      cells={cells}
      audioCues={audioCues}
      existingCount={0}
      onConfirm={vi.fn()}
      onConfirmAudio={onConfirmAudio}
      onCancel={() => {}}
      {...over}
    />,
  )
  const file = new File([csv], "audio-characters.csv", { type: "text/csv" })
  fireEvent.change(screen.getByTestId("import-characters-audio-input"), {
    target: { files: [file] },
  })
  return { onConfirmAudio }
}

describe("the audio character sheet", () => {
  it("assigns characters to the HEARD lines, matched on their words", () => {
    // Deliberately at times that match no cue: this sheet carries the delivered
    // file's own 24fps stamps while the cues have been corrected onto 23.976.
    // The wording is what pairs them.
    return pickAudio(
      AUDIO_CSV(
        audioRow("00:09:99.000", "LITTLE MARY MAGDALENE (ON)", "Abba?", "ON"),
        audioRow("00:19:99.000", "LITTLE MARY MAGDALENE (ON)", "I can't sleep.", "ON"),
      ),
    ).then(async ({ onConfirmAudio }) => {
      await waitFor(() =>
        expect(screen.getByTestId("import-characters-summary")).toHaveTextContent(
          "2 heard lines get a character",
        ),
      )
      fireEvent.click(screen.getByTestId("import-characters-confirm"))
      const [plan] = onConfirmAudio.mock.calls[0]
      expect(plan.assignments).toEqual([
        // `lineNumber` is her own `Line #` — column 0 of the audio sheet, which
        // the fixture rows all set to "10", the number episode 101 starts at.
        { cellId: "q1", castName: "LITTLE MARY MAGDALENE", cameraState: "on", rowNumber: 2, lineNumber: "10" },
        { cellId: "q2", castName: "LITTLE MARY MAGDALENE", cameraState: "on", rowNumber: 3, lineNumber: "10" },
      ])
    })
  })

  it("is not offered when the file has no audio cues", () => {
    render(
      <ImportCharactersDialog
        open textFileName="ep101.vtt" cells={cells} existingCount={0}
        onConfirm={vi.fn()} onCancel={() => {}}
      />,
    )
    expect(screen.queryByTestId("import-characters-audio-input")).not.toBeInTheDocument()
    expect(screen.getByTestId("import-characters-input")).toBeInTheDocument()
  })

  it("says which button a misfiled sheet belongs under", async () => {
    // A SUBTITLE sheet handed to the audio button. Its rows key to the subtitle
    // timestamps and match almost no heard line.
    await pickAudio(CSV(row("00:00:10.000", "JESUS."), row("00:00:20.000", "MARY")))
    await waitFor(() =>
      expect(screen.getByTestId("import-characters-wrongkind")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("import-characters-wrongkind")).toHaveTextContent(
      "subtitle character sheet",
    )
    expect(screen.getByTestId("import-characters-confirm")).toBeDisabled()
  })

  it("REFUSES an audio sheet from a different episode", async () => {
    // Times well outside this file too, so it cannot be mistaken for the
    // subtitle sheet either — this is the wrong EPISODE, not the wrong button.
    const { onConfirmAudio } = await pickAudio(
      AUDIO_CSV(
        audioRow("00:41:10.000", "PILATE (ON)", "What is truth?", "ON"),
        audioRow("00:41:20.000", "CLAUDIA (ON)", "You did not sleep.", "ON"),
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("import-characters-mismatch")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("import-characters-mismatch")).toHaveTextContent("heard line")
    fireEvent.click(screen.getByTestId("import-characters-confirm"))
    expect(onConfirmAudio).not.toHaveBeenCalled()
  })
})


// ── Taking a sheet back off (AQU-646, Sam 2026-08-20) ────────────────────
//
// "There isn't a way to unimport imported sources files… there should be."
// Remove means CLEAR, and the two sheets clear independently, so this is two
// removals in one dialog rather than one that guesses which was meant.

describe("clearing a sheet", () => {
  const both = {
    open: true,
    textFileName: "ep101.vtt",
    cells,
    onConfirm: vi.fn(),
    onCancel: () => {},
  } as const

  it("offers a side only when that side has something on it", () => {
    render(
      <ImportCharactersDialog
        {...both} existingCount={637} existingAudioCount={0}
        onClearSubtitles={vi.fn()} onClearAudio={vi.fn()}
      />,
    )
    expect(screen.getByTestId("import-characters-clear-subtitle")).toBeInTheDocument()
    expect(screen.queryByTestId("import-characters-clear-audio")).not.toBeInTheDocument()
  })

  it("offers neither without the clearance to do it", () => {
    // The absent-handler convention: no project lead, no removal, and the
    // dialog never renders a button that would only fail.
    render(<ImportCharactersDialog {...both} existingCount={637} existingAudioCount={548} />)
    expect(screen.queryByTestId("import-characters-clear-subtitle")).not.toBeInTheDocument()
    expect(screen.queryByTestId("import-characters-clear-audio")).not.toBeInTheDocument()
  })

  it("asks twice — the first click confirms rather than clears", () => {
    const onClearSubtitles = vi.fn()
    render(
      <ImportCharactersDialog {...both} existingCount={637} onClearSubtitles={onClearSubtitles} />,
    )
    fireEvent.click(screen.getByTestId("import-characters-clear-subtitle"))
    expect(onClearSubtitles).not.toHaveBeenCalled()
    expect(screen.getByTestId("import-characters-clear-subtitle-confirm")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("import-characters-clear-subtitle-go"))
    expect(onClearSubtitles).toHaveBeenCalledTimes(1)
  })

  it("promises the number that will actually change, not the number named", () => {
    // The divergence: the clear touches any line carrying a name OR an angle OR
    // a line number, but the confirmation used to quote the named count. On a
    // file where someone resolved an angle onto an unnamed line, it understated
    // the very warning whose job is to be believed.
    render(
      <ImportCharactersDialog
        {...both} existingCount={637} clearableCount={640} onClearSubtitles={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("import-characters-clear-subtitle"))
    const box = screen.getByTestId("import-characters-clear-subtitle-confirm")
    expect(box).toHaveTextContent(/640 lines lose their character name/)
    // …while the dialog's opening sentence still answers its own question —
    // how many CARRY a character — which is the smaller number.
    expect(screen.getByText(/637 subtitle lines carry a character/)).toBeInTheDocument()
  })

  it("offers a clear on a side holding nothing but stray camera angles", () => {
    // Nothing there "carries a character", so the old gate hid the clear and
    // left the angles stranded with no way to remove them.
    render(
      <ImportCharactersDialog
        {...both} existingCount={0} clearableCount={3} onClearSubtitles={vi.fn()}
      />,
    )
    expect(screen.getByTestId("import-characters-clear-subtitle")).toBeInTheDocument()
  })

  it("falls back to the named count when nothing wider is supplied", () => {
    // Every file imported straight from a sheet has the two counts equal, and
    // callers that predate the prop must keep working.
    render(<ImportCharactersDialog {...both} existingCount={637} onClearSubtitles={vi.fn()} />)
    fireEvent.click(screen.getByTestId("import-characters-clear-subtitle"))
    expect(screen.getByTestId("import-characters-clear-subtitle-confirm")).toHaveTextContent(
      /637 lines lose their character name/,
    )
  })

  it("says how many lines and that hand corrections go too", () => {
    render(
      <ImportCharactersDialog {...both} existingCount={637} onClearSubtitles={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId("import-characters-clear-subtitle"))
    const box = screen.getByTestId("import-characters-clear-subtitle-confirm")
    expect(box).toHaveTextContent(/637 lines lose their character name, camera angle and line number/)
    expect(box).toHaveTextContent(/Corrections made since the import go too/)
  })

  it("warns that the heard lines go blank only when they have no names of their own", () => {
    // The links carry names ONE WAY. With cues present but unnamed, clearing
    // the subtitles empties them too — the consequence a reader cannot infer.
    const { unmount } = render(
      <ImportCharactersDialog
        {...both} existingCount={637} existingAudioCount={0} audioCues={audioCues}
        onClearSubtitles={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("import-characters-clear-subtitle"))
    expect(screen.getByTestId("import-characters-clear-subtitle-confirm")).toHaveTextContent(
      /heard lines read their characters from these, so they go blank as well/,
    )
    unmount()

    // Cues with their OWN sheet keep their names, so the warning would be a lie.
    render(
      <ImportCharactersDialog
        {...both} existingCount={637} existingAudioCount={548} audioCues={audioCues}
        onClearSubtitles={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("import-characters-clear-subtitle"))
    expect(screen.getByTestId("import-characters-clear-subtitle-confirm")).not.toHaveTextContent(
      /go blank as well/,
    )
  })

  it("tells the heard side where its characters will come from instead", () => {
    const { unmount } = render(
      <ImportCharactersDialog
        {...both} existingCount={637} existingAudioCount={548} audioCues={audioCues}
        onClearAudio={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("import-characters-clear-audio"))
    expect(screen.getByTestId("import-characters-clear-audio-confirm")).toHaveTextContent(
      /go back to reading their characters from the subtitles/,
    )
    unmount()

    render(
      <ImportCharactersDialog
        {...both} existingCount={0} existingAudioCount={548} audioCues={audioCues}
        onClearAudio={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("import-characters-clear-audio"))
    expect(screen.getByTestId("import-characters-clear-audio-confirm")).toHaveTextContent(
      /show no character at all/,
    )
  })

  it("backs out without clearing", () => {
    const onClearAudio = vi.fn()
    render(
      <ImportCharactersDialog
        {...both} existingCount={0} existingAudioCount={548} audioCues={audioCues}
        onClearAudio={onClearAudio}
      />,
    )
    fireEvent.click(screen.getByTestId("import-characters-clear-audio"))
    fireEvent.click(screen.getByTestId("import-characters-clear-cancel"))
    expect(onClearAudio).not.toHaveBeenCalled()
    expect(screen.getByTestId("import-characters-clear-audio")).toBeInTheDocument()
  })
})
