// Extracting a clip's subtitles: the report is the point. (AQU-1139)
//
// A video arrives with several sidecar files — the subtitle track, a
// forced-narrative track, another language — and nothing about the filename
// tells them apart. So the dialog parses in the browser and states what it
// found BEFORE any event is written, and the two numbers that give a wrong pick
// away (how many cues, and the stretch of clip they cover) have to be on screen
// beside a confirm button that is dead until there is something to confirm.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { ImportSubtitlesDialog } from "./ImportSubtitlesDialog"

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.500
The art of survival

00:00:04.000 --> 00:00:06.250
begins with water.
`

function open(props: Partial<React.ComponentProps<typeof ImportSubtitlesDialog>> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <ImportSubtitlesDialog
      open
      textFileName="survival-ep1"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  )
  return { onConfirm, onCancel }
}

function pick(content: string, fileName: string) {
  const input = screen.getByTestId("import-subtitles-input")
  fireEvent.change(input, {
    target: { files: [new File([content], fileName, { type: "text/plain" })] },
  })
}

describe("ImportSubtitlesDialog", () => {
  it("offers nothing to confirm until a file has been read", () => {
    open()
    expect(screen.getByTestId("import-subtitles-confirm")).toBeDisabled()
  })

  it("reports the cue count and the span before anything is written", async () => {
    const { onConfirm } = open()
    pick(VTT, "survival-ep1.vtt")

    await waitFor(() =>
      expect(screen.getByTestId("import-subtitles-confirm")).not.toBeDisabled(),
    )
    expect(screen.getByTestId("import-subtitles-summary")).toHaveTextContent(
      "2 cues, 0:01 – 0:06",
    )
    // Nothing is written by picking — the confirm is the only write.
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("hands the parsed cues over on confirm", async () => {
    const { onConfirm } = open()
    pick(VTT, "survival-ep1.vtt")
    await waitFor(() =>
      expect(screen.getByTestId("import-subtitles-confirm")).not.toBeDisabled(),
    )

    fireEvent.click(screen.getByTestId("import-subtitles-confirm"))
    expect(onConfirm).toHaveBeenCalledOnce()
    const [parsed] = onConfirm.mock.calls[0]
    expect(parsed.cues.map((c: { original: string }) => c.original)).toEqual([
      "The art of survival",
      "begins with water.",
    ])
    expect(parsed.report).toMatchObject({ format: "vtt", totalCues: 2 })
  })

  it("refuses a text file that isn't one of the three subtitle formats", async () => {
    open()
    pick("The art of survival\n", "survival-ep1.txt")

    await waitFor(() =>
      expect(screen.getByTestId("import-subtitles-error")).toHaveTextContent(
        /isn't a subtitle file/,
      ),
    )
    expect(screen.getByTestId("import-subtitles-confirm")).toBeDisabled()
  })

  it("refuses the clip itself, dropped onto the picker in place of its sidecar", async () => {
    // The crudest form of the mistake this dialog exists to catch. It is the
    // text DECODER that turns this one away rather than the format check, which
    // is why the message names bytes rather than extensions — worth pinning, so
    // nobody 'fixes' the decode gate and leaves a binary blob reaching a parser.
    open()
    pick("\u0000\u0000\u0000\u0018ftypmp42", "survival-ep1.mp4")

    await waitFor(() =>
      expect(screen.getByTestId("import-subtitles-error")).toHaveTextContent(/binary/),
    )
    expect(screen.getByTestId("import-subtitles-confirm")).toBeDisabled()
  })

  it("refuses a subtitle file that yielded no cues", async () => {
    open()
    pick("WEBVTT\n\n", "empty.vtt")

    await waitFor(() =>
      expect(screen.getByTestId("import-subtitles-error")).toHaveTextContent(
        /No subtitle cues/,
      ),
    )
    expect(screen.getByTestId("import-subtitles-confirm")).toBeDisabled()
  })

  it("counts a cue whose range it could not read, rather than losing it silently", async () => {
    // An untimed cue still imports — it is translatable text — but it cannot be
    // placed against the clip, and that is worth saying before the write rather
    // than leaving someone to hunt for a row that never appeared on a lane.
    open()
    pick(
      `WEBVTT

00:00:01.000 --> 00:00:02.000
timed

00:00:03.000 --> 00:00
untimed
`,
      "mixed.vtt",
    )

    await waitFor(() =>
      expect(screen.getByTestId("import-subtitles-confirm")).not.toBeDisabled(),
    )
    // The malformed range never opens a cue, so it reports as dropped rather
    // than as an untimed row — the silent-loss case the parser's strictness
    // creates and `repairShortFormCueTimestamps` exists to narrow.
    expect(screen.getByTestId("import-subtitles-dropped")).toHaveTextContent("1")
  })
})
