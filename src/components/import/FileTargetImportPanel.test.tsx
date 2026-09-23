/**
 * FileTargetImportPanel — optimistic bulk import (FRO-IMPORT-OPT)
 *
 * WHY: When the user clicks "Import N cells" the panel must:
 *   1. Immediately call applyOptimisticTargetEdits so the open editor
 *      reflects the imported translations without waiting for network.
 *   2. Enqueue in the background (applyEBibleTargetImport) and call
 *      onImported when the outbox accepts the work.
 *   3. NOT stay stuck in a blocking "importing" spinner — the optimistic
 *      patch means the editor already shows the result, so the dialog
 *      can close promptly.
 *
 * Test seam: drive the component to the "review" step by simulating a
 * file drop with a tiny USFM fixture (two verses). The panel handles USFM
 * inline (usfmToTargetRows + matchTargetRowsByRef), so we only need to mock
 * the outbox call (applyEBibleTargetImport) and the optimistic patch fn.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"

// ── Mock the heavy outbox call ────────────────────────────────────────────────
vi.mock("@/lib/import", () => ({
  applyEBibleTargetImport: vi.fn(),
}))
// ScrollArea (in the spreadsheet column mapping) uses @base-ui/react, which
// calls getAnimations() — not in jsdom. Replace it with a passthrough div.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

import { FileTargetImportPanel, type FileTargetPanelBack } from "./FileTargetImportPanel"
import { applyEBibleTargetImport } from "@/lib/import"

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal USFM with two verses that will produce two matched cells when
 *  matched against the two FileTargetCellRef rows below. */
const USFM_FIXTURE = `\\id GEN
\\c 1
\\v 1 First verse translation
\\v 2 Second verse translation
`

const BASE_CELLS = [
  {
    cellId: "cell-gen-1-1",
    fileId: "file-1",
    canonicalRef: "GEN 1:1",
    sourceEventId: "se-1",
    targetEventId: undefined,
    translated: "",
    original: "In the beginning",
  },
  {
    cellId: "cell-gen-1-2",
    fileId: "file-1",
    canonicalRef: "GEN 1:2",
    sourceEventId: "se-2",
    targetEventId: undefined,
    translated: "",
    original: "And the earth was formless",
  },
]

function makeFile(content: string, name = "genesis.usfm"): File {
  return new File([content], name, { type: "text/plain" })
}

async function selectFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    fireEvent.change(input)
    await new Promise((r) => setTimeout(r, 0))
  })
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof FileTargetImportPanel>> = {}) {
  const defaults: React.ComponentProps<typeof FileTargetImportPanel> = {
    projectId: "proj-1",
    username: "tester",
    fileName: "Genesis.usfm",
    cells: BASE_CELLS,
    getToken: vi.fn(async () => "tok"),
    onImported: vi.fn(),
    onCancel: vi.fn(),
    applyOptimisticTargetEdits: vi.fn(),
  }
  return render(<FileTargetImportPanel {...defaults} {...overrides} />)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FileTargetImportPanel — optimistic bulk import", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // applyEBibleTargetImport resolves fast (outbox-enqueue is synchronous/local).
    vi.mocked(applyEBibleTargetImport).mockResolvedValue({ committedCount: 2, skippedCount: 0 })
  })

  it("reaches the review step after a USFM file is selected", async () => {
    renderPanel()
    await selectFile(makeFile(USFM_FIXTURE))
    // Review screen shows matched-count summary
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText(/2 matched/i)).toBeInTheDocument()
  })

  it("calls applyOptimisticTargetEdits with both cells before network resolves", async () => {
    const applyOptimisticTargetEdits = vi.fn()
    // Make the outbox call never resolve during this assertion so we can
    // confirm optimistic call fires synchronously before await.
    let resolveImport!: (v: { committedCount: number; skippedCount: number }) => void
    vi.mocked(applyEBibleTargetImport).mockReturnValue(
      new Promise((res) => { resolveImport = res }),
    )

    renderPanel({ applyOptimisticTargetEdits })
    await selectFile(makeFile(USFM_FIXTURE))
    await screen.findByText(/review matches/i)

    // Click "Import 2 cells"
    const importBtn = screen.getByRole("button", { name: /import 2/i })
    await act(async () => {
      fireEvent.click(importBtn)
    })

    // Optimistic patch must already have fired (before network settles)
    expect(applyOptimisticTargetEdits).toHaveBeenCalledOnce()
    const patches = applyOptimisticTargetEdits.mock.calls[0][0] as { cellId: string; value: string }[]
    expect(patches).toHaveLength(2)
    expect(patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cellId: "cell-gen-1-1", value: expect.any(String) }),
        expect.objectContaining({ cellId: "cell-gen-1-2", value: expect.any(String) }),
      ]),
    )

    // Let the import finish so cleanup doesn't have pending state
    await act(async () => {
      resolveImport({ committedCount: 2, skippedCount: 0 })
      await new Promise((r) => setTimeout(r, 0))
    })
  })

  it("calls onImported with the committed count after the outbox enqueues", async () => {
    const onImported = vi.fn()
    renderPanel({ onImported })
    await selectFile(makeFile(USFM_FIXTURE))
    await screen.findByText(/review matches/i)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /import 2/i }))
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(2))
  })

  it("does not leave the UI stuck in a blocking importing state on success", async () => {
    renderPanel()
    await selectFile(makeFile(USFM_FIXTURE))
    await screen.findByText(/review matches/i)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /import 2/i }))
      await new Promise((r) => setTimeout(r, 0))
    })

    // After success, onImported closes the dialog (tested separately).
    // The panel itself must not be stuck rendering the "Importing…" spinner
    // forever — either onImported fired (closing the dialog) or review is still shown.
    // What must NOT happen: "Importing…" visible with no way out.
    // Since onImported is a mock (doesn't close), we check optimistic was called
    // and the spinner text is gone (panel moved on).
    await waitFor(() => {
      // The "Importing…" text from the blocking spinner step should not be present
      // after the outbox call settles. (onImported would close the dialog in real usage.)
      // Here we just confirm we didn't get stuck — the component is past "importing" step.
      expect(screen.queryByText(/applying translations/i)).not.toBeInTheDocument()
    })
  })

  it("shows an error and returns to review when applyEBibleTargetImport throws", async () => {
    vi.mocked(applyEBibleTargetImport).mockRejectedValue(new Error("Network timeout"))
    const onImported = vi.fn()
    renderPanel({ onImported })
    await selectFile(makeFile(USFM_FIXTURE))
    await screen.findByText(/review matches/i)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /import 2/i }))
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => expect(screen.getByText(/network timeout/i)).toBeInTheDocument())
    expect(onImported).not.toHaveBeenCalled()
    // Review step should still be visible so user can retry
    expect(screen.getByText(/review matches/i)).toBeInTheDocument()
  })

  // WHY: the optimistic patch renders imported text instantly, but if the
  // (local) enqueue throws, nothing was actually queued. Leaving the patch in
  // place shows phantom translations that only a later revalidate would clear.
  // The failure path must roll the patch back to each cell's pre-import value.
  it("rolls back the optimistic patch when the enqueue throws", async () => {
    vi.mocked(applyEBibleTargetImport).mockRejectedValue(new Error("Network timeout"))
    const applyOptimisticTargetEdits = vi.fn()
    renderPanel({ applyOptimisticTargetEdits })
    await selectFile(makeFile(USFM_FIXTURE))
    await screen.findByText(/review matches/i)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /import 2/i }))
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => expect(screen.getByText(/network timeout/i)).toBeInTheDocument())
    // Called twice: once forward (imported text) then once to revert.
    expect(applyOptimisticTargetEdits).toHaveBeenCalledTimes(2)
    const forward = applyOptimisticTargetEdits.mock.calls[0][0] as { cellId: string; value: string }[]
    const rollback = applyOptimisticTargetEdits.mock.calls[1][0] as { cellId: string; value: string }[]
    // Forward patch carried the imported (non-empty) translations…
    expect(forward.every((p) => p.value.length > 0)).toBe(true)
    // …the rollback restored each cell's pre-import value (empty here).
    expect(rollback.map((p) => p.cellId).sort()).toEqual(forward.map((p) => p.cellId).sort())
    expect(rollback.every((p) => p.value === "")).toBe(true)
  })

  // AQU-1142: a translated WebVTT delivered by a subtitling partner must
  // populate the open file's target column. Cues match cells positionally
  // (cue N → cell N) because VTT-sourced cells don't carry canonical refs,
  // and the review screen labels rows by timecode rather than an internal id.
  it("AQU-1142: routes a .vtt drop into the review step, matched positionally, with timecode labels", async () => {
    const VTT_FIXTURE = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "First cue translated",
      "",
      "00:00:05.000 --> 00:00:08.000",
      "Second&nbsp;cue translated",
    ].join("\n")
    renderPanel()
    await selectFile(makeFile(VTT_FIXTURE, "episode.vtt"))
    // Went straight to review — not the "unsupported file type" error path.
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText(/2 matched/i)).toBeInTheDocument()
    // Positional matching triggers the order-match warning.
    expect(screen.getByText(/matched .* in order/i)).toBeInTheDocument()
    // Rows are labelled by the cue's timecode, never by an internal UUID.
    expect(screen.getByText(/00:00:01\.000\s*-->\s*00:00:04\.000/)).toBeInTheDocument()
    expect(screen.getByText(/00:00:05\.000\s*-->\s*00:00:08\.000/)).toBeInTheDocument()
    // &nbsp; must be decoded before it can reach a target cell.
    expect(screen.getByText("Second cue translated")).toBeInTheDocument()
    expect(screen.queryByText(/&nbsp;/)).not.toBeInTheDocument()
  })

  // WHY: while a slow enqueue is in flight the Import button must be disabled so
  // a second click can't re-optimistic-patch and re-enqueue the same cells.
  it("disables the Import button while an enqueue is in flight (no double-submit)", async () => {
    let resolveImport!: (v: { committedCount: number; skippedCount: number }) => void
    vi.mocked(applyEBibleTargetImport).mockReturnValue(
      new Promise((res) => { resolveImport = res }),
    )
    renderPanel()
    await selectFile(makeFile(USFM_FIXTURE))
    await screen.findByText(/review matches/i)

    const importBtn = screen.getByRole("button", { name: /import 2/i })
    await act(async () => { fireEvent.click(importBtn) })

    // The in-flight enqueue leaves exactly one call; the button is now disabled
    // and a second click is a no-op.
    expect(importBtn).toBeDisabled()
    await act(async () => { fireEvent.click(importBtn) })
    expect(vi.mocked(applyEBibleTargetImport)).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveImport({ committedCount: 2, skippedCount: 0 })
      await new Promise((r) => setTimeout(r, 0))
    })
  })
})

// ── AQU-1144: subtitle (.srt / .sbv) target import ───────────────────────────
//
// WHY: dubbing vendors deliver SRT/SBV, not spreadsheets. The panel must route
// those extensions through the cue parsers, land on the review screen with the
// cue's TIMECODE as the row label (cue cells have opaque uuid group ids, so a
// UUID would be the only alternative), and match positionally — which means the
// order-match warning has to be visible before anything commits.

describe("FileTargetImportPanel — subtitle target import (AQU-1144)", () => {
  const SRT_FIXTURE = [
    "1",
    "00:00:01,000 --> 00:00:04,000",
    "First cue translation",
    "",
    "2",
    "00:00:05,500 --> 00:00:08,250",
    "Second cue translation",
    "",
  ].join("\n")

  const SBV_FIXTURE = [
    "0:00:01.000,0:00:04.000",
    "First cue translation",
    "",
    "0:00:05.500,0:00:08.250",
    "Second cue translation",
    "",
  ].join("\n")

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(applyEBibleTargetImport).mockResolvedValue({ committedCount: 2, skippedCount: 0 })
  })

  it("reaches the review step for a .srt file, labelled by cue timecode", async () => {
    renderPanel()
    await selectFile(makeFile(SRT_FIXTURE, "episode-101-tpi.srt"))

    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText(/2 matched/i)).toBeInTheDocument()
    expect(screen.getByText("00:00:01,000 --> 00:00:04,000")).toBeInTheDocument()
    expect(screen.getByText("00:00:05,500 --> 00:00:08,250")).toBeInTheDocument()
    // Positional matching is lossy if the cue count drifts, so the user must be
    // warned to eyeball alignment before importing.
    expect(screen.getByText(/matched to cells in order/i)).toBeInTheDocument()
  })

  it("reaches the review step for a .sbv file, labelled by cue timecode", async () => {
    renderPanel()
    await selectFile(makeFile(SBV_FIXTURE, "episode-101-tpi.sbv"))

    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText(/2 matched/i)).toBeInTheDocument()
    expect(screen.getByText("0:00:01.000,0:00:04.000")).toBeInTheDocument()
  })

  it("never shows the SRT numeric cue counters as incoming translations", async () => {
    renderPanel()
    await selectFile(makeFile(SRT_FIXTURE, "episode-101-tpi.srt"))
    await screen.findByText(/review matches/i)

    expect(screen.getByText("First cue translation")).toBeInTheDocument()
    expect(screen.getByText("Second cue translation")).toBeInTheDocument()
    // The "1"/"2" counter lines are structural, not text to translate.
    expect(screen.queryByText("1")).not.toBeInTheDocument()
    expect(screen.queryByText("2")).not.toBeInTheDocument()
  })

  it("tags the uploaded source artifact with the subtitle format, not csv", async () => {
    renderPanel()
    await selectFile(makeFile(SRT_FIXTURE, "episode-101-tpi.srt"))
    await screen.findByText(/review matches/i)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /import 2/i }))
      await new Promise((r) => setTimeout(r, 0))
    })

    const opts = vi.mocked(applyEBibleTargetImport).mock.calls[0][2] as {
      sourceArtifact: { format: string; name: string }
    }
    expect(opts.sourceArtifact.format).toBe("srt")
  })

  it("reports a subtitle file with no cues instead of an empty review screen", async () => {
    renderPanel()
    await selectFile(makeFile("this file has no cues at all\n", "broken.srt"))

    expect(await screen.findByText(/no subtitle cues found/i)).toBeInTheDocument()
    expect(screen.queryByText(/review matches/i)).not.toBeInTheDocument()
  })

  it("still rejects a genuinely unsupported extension", async () => {
    renderPanel()
    await selectFile(makeFile("whatever", "notes.rtf"))

    expect(await screen.findByText(/unsupported file type/i)).toBeInTheDocument()
    expect(screen.queryByText(/review matches/i)).not.toBeInTheDocument()
  })
})

describe("FileTargetImportPanel — a review screen that says what happened (AQU-1360)", () => {
  const tc = (ms: number) => {
    const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60
    const pad = (n: number, w = 2) => String(n).padStart(w, "0")
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`
  }
  const line = (n: number, startMs: number, endMs: number, translated = "") => ({
    cellId: `line-${n}`,
    fileId: "file-1",
    canonicalRef: null,
    sourceEventId: `se-${n}`,
    targetEventId: undefined,
    translated,
    original: `SOURCE ${n}`,
    startMs,
    endMs,
    cueRef: `${tc(startMs)} --> ${tc(endMs)}`,
  })
  const vtt = (cues: [number, number, string][]) =>
    ["WEBVTT", "", ...cues.flatMap(([a, b, text]) => [`${tc(a)} --> ${tc(b)}`, text, ""])].join("\n")
  const checkboxFor = (text: string) =>
    screen.getByText(text).closest("label")!.querySelector("input") as HTMLInputElement
  const rowOf = (text: string) => screen.getByText(text).closest("label")!

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(applyEBibleTargetImport).mockResolvedValue({ committedCount: 0, skippedCount: 0 })
  })

  const four = [line(1, 10000, 10800), line(2, 20000, 20800), line(3, 30000, 30800), line(4, 40000, 40800)]

  it("names the cues that found no line, with the reason, and the lines left without a translation — in amber", async () => {
    renderPanel({ cells: four })
    await selectFile(makeFile(vtt([
      [10000, 10800, "TARGET 1"],
      [30000, 28000, "TARGET 3 backwards"],
      [100000, 100800, "TARGET far away"],
    ]), "episode.vtt"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText("1 unmatched row")).toHaveClass("text-amber-600")
    expect(screen.getByText("1 broken timecode")).toHaveClass("text-amber-600")
    expect(screen.getByText("3 cells not covered")).toHaveClass("text-amber-600")
    // The lists, with a reason per cue and each uncovered line by name.
    expect(screen.getByText("Timecode ends before it starts")).toBeInTheDocument()
    expect(screen.getByText("No line within reach")).toBeInTheDocument()
    expect(screen.getByText("TARGET 3 backwards")).toBeInTheDocument()
    for (const name of ["SOURCE 2", "SOURCE 3", "SOURCE 4"]) expect(screen.getByText(name)).toBeInTheDocument()
  })

  it("leaves contested, shared-timing and already-there rows unticked, and won't tick an already-there row", async () => {
    renderPanel({
      cells: [
        line(1, 10000, 10400),
        line(2, 10500, 10900),
        line(3, 20000, 21500),
        line(4, 20000, 21500),
        line(5, 30000, 30800, "same words"),
      ],
    })
    await selectFile(makeFile(vtt([
      [10500, 10900, "swap one"],
      [10500, 10900, "swap two"],
      [20000, 21500, "PETER"],
      [20000, 21500, "ANDREW"],
      [30000, 30800, "same words"],
    ]), "episode.vtt"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    for (const text of ["swap one", "swap two", "PETER", "ANDREW", "same words"]) {
      expect(checkboxFor(text).checked).toBe(false)
    }
    expect(checkboxFor("same words").disabled).toBe(true)
    // The two rows that fought over one line share a number; shared-timing rows get their own pill.
    expect(screen.getAllByText("Contest 1")).toHaveLength(2)
    expect(rowOf("swap one")).toHaveTextContent("Contest 1")
    expect(rowOf("swap two")).toHaveTextContent("Contest 1")
    expect(screen.getAllByText("Same timing")).toHaveLength(2)
    expect(rowOf("PETER")).toHaveTextContent("Same timing")
    expect(screen.getByText("Already there")).toBeInTheDocument()
    expect(screen.getByText(/1 contest: the rows marked Contest 1 competed for the same line/)).toBeInTheDocument()
    expect(screen.getByText(/2 rows have exactly the same timing as another cue/)).toBeInTheDocument()
    // "Select all" never ticks a row whose text is already there.
    fireEvent.click(screen.getByText(/select all/i))
    expect(checkboxFor("same words").checked).toBe(false)
    expect(checkboxFor("PETER").checked).toBe(true)
  })

  it("numbers each contest, so the rows that fought over one line can be found together", async () => {
    renderPanel({
      cells: [
        line(1, 10000, 10400), line(2, 10500, 10900), line(3, 20000, 20400),
        line(4, 30000, 32000), line(5, 32500, 33500),
      ],
    })
    await selectFile(makeFile(vtt([
      [10450, 10850, "swap one"],
      [10500, 10900, "swap two"],
      [20000, 20400, "third"],
      [30000, 31000, "half one"],
      [31000, 32000, "half two"],
      [32500, 33500, "next"],
    ]), "episode.vtt"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText(/2 contests: rows marked with the same Contest number/)).toBeInTheDocument()
    expect(rowOf("swap one")).toHaveTextContent("Contest 1")
    expect(rowOf("swap two")).toHaveTextContent("Contest 1")
    expect(rowOf("half one")).toHaveTextContent("Contest 2")
    expect(rowOf("third")).not.toHaveTextContent("Contest")
    // The half that lost its line is in the unmatched list, carrying the same number.
    const lost = screen.getByText("half two").closest("li")!
    expect(lost).toHaveTextContent("Lost its line to another cue")
    expect(lost).toHaveTextContent("Contest 2")
    expect(screen.getAllByText("Contest 2")[0]).toHaveAttribute(
      "title",
      "Competed for the same line as the other rows marked Contest 2. Check them before importing.",
    )
  })

  it("marks a shifted cue's row \"Timing differs\" and shows the line's own timecode, on that row only", async () => {
    renderPanel({ cells: four })
    await selectFile(makeFile(vtt([[10300, 11100, "TARGET 1 late"], [20000, 20800, "TARGET 2"]]), "episode.vtt"))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    // Line 1's own timecode appears because the cue is 300ms off; line 2's doesn't.
    expect(screen.getByText(/00:00:10\.000 --> 00:00:10\.800/)).toBeInTheDocument()
    expect(screen.queryByText(/00:00:20\.000 --> 00:00:20\.800 /)).not.toBeInTheDocument()
    expect(rowOf("TARGET 1 late")).toHaveTextContent("Timing differs")
    expect(rowOf("TARGET 2")).not.toHaveTextContent("Timing differs")
    expect(screen.getAllByText("Timing differs")).toHaveLength(1)
    // The standing note it replaced is gone.
    expect(screen.queryByText(/keep this file's timings/)).not.toBeInTheDocument()
  })

  it("counts the cues that never became rows", async () => {
    renderPanel({ cells: four })
    await selectFile(makeFile(
      ["WEBVTT", "", `${tc(10000)} --> ${tc(10800)}`, "TARGET 1", "", `${tc(20000)} --> ${tc(20800)}`, "", ""].join("\n"),
      "episode.vtt",
    ))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText("1 cue skipped (empty or unreadable)")).toHaveClass("text-amber-600")
  })

  it("explains a frame-rate correction", async () => {
    const PAL = 25 / (24000 / 1001)
    const cells = Array.from({ length: 30 }, (_, i) =>
      line(i + 1, 5000 + i * 2500, 6200 + i * 2500 + (i % 3) * 300))
    renderPanel({ cells })
    await selectFile(makeFile(
      vtt(cells.map((c, i) => [Math.round(c.startMs / PAL), Math.round(c.endMs / PAL), `TARGET ${i + 1}`])),
      "episode.vtt",
    ))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText(/adjusted from 25 to 23\.976 frames per second/)).toBeInTheDocument()
    expect(screen.getByText("30 matched")).toBeInTheDocument()
  })
})

describe("FileTargetImportPanel — the back arrow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(applyEBibleTargetImport).mockResolvedValue({ committedCount: 2, skippedCount: 0 })
  })

  /** The panel reports the arrow to its host; keep the latest report. */
  function renderWithBack() {
    let back: FileTargetPanelBack | null = null
    const onBackChange = vi.fn((b: FileTargetPanelBack | null) => { back = b })
    renderPanel({ onBackChange })
    return { current: () => back, onBackChange }
  }

  it("has no arrow on the file picker, and leads from the review back to it", async () => {
    const back = renderWithBack()
    expect(back.onBackChange).toHaveBeenCalledWith(null)
    await selectFile(makeFile(USFM_FIXTURE))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(back.current()).toMatchObject({ label: "Back to file selection", disabled: false })

    act(() => back.current()!.onBack())
    expect(screen.queryByText(/review matches/i)).not.toBeInTheDocument()
    expect(screen.getByText(/drop a file here/i)).toBeInTheDocument()
    expect(back.current()).toBeNull()

    // A second file goes straight to its own review.
    await selectFile(makeFile(USFM_FIXTURE.replace("First verse", "Revised verse")))
    expect(await screen.findByText("Revised verse translation")).toBeInTheDocument()
  })

  it("leads a spreadsheet's review back to its column mapping, and the mapping back to the file picker", async () => {
    const back = renderWithBack()
    await selectFile(makeFile("ref,target\nGEN 1:1,Uno\nGEN 1:2,Dos\n", "genesis.csv"))
    expect(await screen.findByRole("button", { name: "Map columns" })).toBeInTheDocument()
    expect(back.current()).toMatchObject({ label: "Back to file selection" })

    fireEvent.click(screen.getByRole("button", { name: "Map columns" }))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(back.current()).toMatchObject({ label: "Back to column mapping" })

    act(() => back.current()!.onBack())
    expect(screen.getByRole("button", { name: "Map columns" })).toBeInTheDocument()
    act(() => back.current()!.onBack())
    expect(screen.getByText(/drop a file here/i)).toBeInTheDocument()
    expect(back.current()).toBeNull()
  })

  it("is disabled while an import is being applied", async () => {
    vi.mocked(applyEBibleTargetImport).mockReturnValue(new Promise(() => {}))
    const back = renderWithBack()
    await selectFile(makeFile(USFM_FIXTURE))
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /import 2 cells/i }))
    })
    expect(back.current()).toMatchObject({ disabled: true })
  })
})
