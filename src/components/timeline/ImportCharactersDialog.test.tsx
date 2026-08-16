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
    expect(screen.getByText("Replace the characters")).toBeInTheDocument()
    expect(screen.getByText(/637 lines already have a character/)).toBeInTheDocument()
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
