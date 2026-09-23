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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, act, fireEvent, waitFor, cleanup, within } from "@testing-library/react"

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
  const rowOf = (text: string) => screen.getByText(text).closest<HTMLElement>("[data-review-cell]")!
  /** Open a collapsible list under the counts; its entries are built only while open. */
  const openList = (title: RegExp) => {
    const details = screen.getByText(title).closest("details")!
    act(() => {
      details.open = true
      fireEvent(details, new Event("toggle"))
    })
  }

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
    // The lists, with a reason per cue and each uncovered line by name —
    // built only once opened.
    expect(screen.queryByText("TARGET 3 backwards")).not.toBeInTheDocument()
    openList(/Cues that didn't find a line/)
    openList(/Lines left without a translation/)
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
    // Rows that fought over one line carry a "Contested" button; shared-timing rows get their own pill.
    expect(within(rowOf("swap one")).getByRole("button", { name: "Go to the cue this one competed with" }))
      .toHaveTextContent("Contested")
    expect(within(rowOf("swap two")).getByRole("button", { name: "Go to the cue this one competed with" }))
      .toHaveTextContent("Contested")
    expect(screen.getAllByText("Same timing")).toHaveLength(2)
    expect(rowOf("PETER")).toHaveTextContent("Same timing")
    expect(screen.getByText("Already there")).toBeInTheDocument()
    expect(screen.getByText(/2 rows competed with another cue for the same line and were left unticked/)).toBeInTheDocument()
    expect(screen.getByText(/2 rows have exactly the same timing as another cue/)).toBeInTheDocument()
    // "Select all" never ticks a row whose text is already there.
    fireEvent.click(screen.getByText(/select all/i))
    expect(checkboxFor("same words").checked).toBe(false)
    expect(checkboxFor("PETER").checked).toBe(true)
  })

  describe("\"Contested\" jumps to the cue a row competed with", () => {
    const contestLines = [
      line(1, 10000, 10400), line(2, 10500, 10900), line(3, 20000, 20400),
      line(4, 30000, 32000), line(5, 32500, 33500),
    ]
    const contestFile = vtt([
      [10450, 10850, "swap one"],
      [10500, 10900, "swap two"],
      [20000, 20400, "third"],
      [30000, 31000, "half one"],
      [31000, 32000, "half two"],
      [32500, 33500, "next"],
    ])
    const contestedButton = (text: string) =>
      within(rowOf(text)).getByRole("button", { name: "Go to the cue this one competed with" })
    const lit = () => [...document.querySelectorAll("[data-highlighted]")].map((el) => el.textContent)

    it("goes to the row it competed with, and back — without ticking either", async () => {
      renderPanel({ cells: contestLines })
      await selectFile(makeFile(contestFile, "episode.vtt"))
      expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
      expect(screen.getByText(/3 rows competed with another cue for the same line/)).toBeInTheDocument()
      expect(within(rowOf("third")).queryByRole("button")).toBeNull()

      fireEvent.click(contestedButton("swap one"))
      expect(rowOf("swap two")).toHaveAttribute("data-highlighted", "true")
      expect(lit()).toHaveLength(1)
      fireEvent.click(contestedButton("swap two"))
      expect(rowOf("swap one")).toHaveAttribute("data-highlighted", "true")
      expect(rowOf("swap two")).not.toHaveAttribute("data-highlighted")
      expect(checkboxFor("swap one").checked).toBe(false)
      expect(checkboxFor("swap two").checked).toBe(false)
    })

    it("opens the unmatched list at the half that lost its line, and that cue goes back to the row", async () => {
      renderPanel({ cells: contestLines })
      await selectFile(makeFile(contestFile, "episode.vtt"))
      expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
      expect(screen.queryByText("half two")).toBeNull() // the list starts closed

      fireEvent.click(contestedButton("half one"))
      const lost = screen.getByText("half two").closest("li")!
      expect(lost).toHaveAttribute("data-highlighted", "true")
      expect(lost).toHaveTextContent("Lost its line to another cue")

      fireEvent.click(within(lost).getByRole("button", { name: "Go to the line it lost to" }))
      expect(rowOf("half one")).toHaveAttribute("data-highlighted", "true")
      expect(lost).not.toHaveAttribute("data-highlighted")
    })

    it("visits every cue in turn when three fought over one line", async () => {
      renderPanel({ cells: [line(1, 30000, 33000), line(2, 40000, 41000)] })
      await selectFile(makeFile(vtt([
        [30000, 31000, "part one"],
        [31000, 32000, "part two"],
        [32000, 33000, "part three"],
        [40000, 41000, "after"],
      ]), "episode.vtt"))
      expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
      fireEvent.click(contestedButton("part one"))
      const entry = (text: string) => screen.getByText(text).closest("li")!
      expect(entry("part two")).toHaveAttribute("data-highlighted", "true")
      fireEvent.click(within(entry("part two")).getByRole("button", { name: "Go to the line it lost to" }))
      expect(entry("part three")).toHaveAttribute("data-highlighted", "true")
      fireEvent.click(within(entry("part three")).getByRole("button", { name: "Go to the line it lost to" }))
      expect(rowOf("part one")).toHaveAttribute("data-highlighted", "true")
    })

    it("lets the glow fade", async () => {
      renderPanel({ cells: contestLines })
      await selectFile(makeFile(contestFile, "episode.vtt"))
      expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
      vi.useFakeTimers()
      try {
        fireEvent.click(contestedButton("swap one"))
        expect(rowOf("swap two")).toHaveAttribute("data-highlighted", "true")
        act(() => { vi.advanceTimersByTime(1700) })
        expect(rowOf("swap two")).not.toHaveAttribute("data-highlighted")
      } finally {
        vi.useRealTimers()
      }
    })
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

  describe("a whole-file shift, offered as a tickbox", () => {
    // An irregular grid, like a real subtitle file: a regular one can't tell
    // the true shift from the one-line-over shift, and is rightly refused.
    const episodeLines = Array.from({ length: 30 }, (_, i) => {
      const start = 5000 + i * 2600 + (i % 4) * 170
      return line(i + 1, start, start + 900 + (i % 5) * 260)
    })
    const shifted = (by: number) =>
      vtt(episodeLines.map((c, i) => [c.startMs + by, c.endMs + by, `TARGET ${i + 1}`]))
    const onOwnLine = () =>
      screen.getAllByText(/^TARGET \d+$/).filter((el) => {
        // Cues that found no line sit in the unmatched list, not in a row.
        const row = el.closest("label")
        return row !== null && new RegExp(`SOURCE ${el.textContent!.split(" ")[1]}(?!\\d)`).test(row.textContent!)
      }).length

    it("applies the shift, ticked, and says how far and how much it helped", async () => {
      renderPanel({ cells: episodeLines })
      await selectFile(makeFile(shifted(2000), "episode.vtt"))
      expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
      const box = screen.getByLabelText(/Shift the uploaded file's timings 2 seconds earlier, which lines up \d+ more lines\./)
      expect(box).toBeChecked()
      expect(onOwnLine()).toBe(30)
      expect(screen.queryByText(/partly overlap/)).not.toBeInTheDocument()
    })

    it("unticked, pairs the file as delivered, and ticked again, shifts it back", async () => {
      renderPanel({ cells: episodeLines })
      await selectFile(makeFile(shifted(2000), "episode.vtt"))
      expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
      const box = () => screen.getByLabelText(/Shift the uploaded file's timings/)
      fireEvent.click(box())
      // The box flips at once and the list turns to placeholders while it re-matches.
      expect(box()).not.toBeChecked()
      expect(box()).toBeDisabled()
      expect(screen.getByRole("status")).toHaveTextContent("Matching lines…")
      await waitFor(() => expect(box()).toBeEnabled())
      expect(box()).not.toBeChecked()
      expect(onOwnLine()).toBeLessThan(10)
      expect(screen.getByText(/partly overlap/)).toBeInTheDocument()
      fireEvent.click(box())
      await waitFor(() => expect(box()).toBeEnabled())
      expect(box()).toBeChecked()
      expect(onOwnLine()).toBe(30)
    })

    it("reads a broadcast hour as a timecode, and a shift the other way as later", async () => {
      renderPanel({ cells: episodeLines })
      await selectFile(makeFile(shifted(3_600_000), "episode.vtt"))
      expect(await screen.findByLabelText(/timings 1:00:00 earlier/)).toBeChecked()
      cleanup()
      renderPanel({ cells: episodeLines.map((c) => ({ ...c, startMs: c.startMs + 5000, endMs: c.endMs + 5000 })) })
      await selectFile(makeFile(shifted(0), "episode.vtt"))
      expect(await screen.findByLabelText(/timings 5 seconds later/)).toBeChecked()
    })

    it("offers nothing on a file that already lines up", async () => {
      renderPanel({ cells: episodeLines })
      await selectFile(makeFile(shifted(0), "episode.vtt"))
      expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
      expect(screen.queryByLabelText(/Shift the uploaded file's timings/)).not.toBeInTheDocument()
    })
  })

  describe("while it works", () => {
    // Hold the browser's next frame, so the in-between state can be looked at
    // before the matching runs.
    let frames: FrameRequestCallback[] = []
    beforeEach(() => {
      frames = []
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    })
    afterEach(() => vi.unstubAllGlobals())
    const releaseFrame = async () => {
      await act(async () => {
        frames.splice(0).forEach((cb) => cb(0))
        await new Promise((r) => setTimeout(r, 0))
      })
    }

    it("shows pulsing placeholder rows under \"Matching lines…\" until the review is ready", async () => {
      renderPanel({ cells: four })
      await selectFile(makeFile(vtt([[10000, 10800, "TARGET 1"]]), "episode.vtt"))
      expect(screen.getByRole("status")).toHaveTextContent("Matching lines…")
      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(5)
      expect(screen.queryByText(/review matches/i)).not.toBeInTheDocument()
      await releaseFrame()
      expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
      expect(document.querySelector('[data-slot="skeleton"]')).toBeNull()
    })

    it("drops a match that finishes after the user went back", async () => {
      let back: FileTargetPanelBack | null = null
      renderPanel({ cells: four, onBackChange: (b) => { back = b } })
      await selectFile(makeFile(vtt([[10000, 10800, "TARGET 1"]]), "episode.vtt"))
      expect(screen.getByRole("status")).toHaveTextContent("Matching lines…")
      act(() => back!.onBack())
      await releaseFrame()
      expect(screen.getByText(/drop a file here/i)).toBeInTheDocument()
      expect(screen.queryByText(/review matches/i)).not.toBeInTheDocument()
    })
  })

  it("draws only the rows on screen for a long file, and every row for a short one", async () => {
    const many = Array.from({ length: 400 }, (_, i) => line(i + 1, 5000 + i * 3000, 6000 + i * 3000))
    renderPanel({ cells: many })
    await selectFile(makeFile(vtt(many.map((c, i) => [c.startMs, c.endMs, `TARGET ${i + 1}`])), "episode.vtt"))
    expect(await screen.findByText("400 matched")).toBeInTheDocument()
    const drawn = document.querySelectorAll("label input[type=checkbox]").length
    expect(drawn).toBeGreaterThan(0)
    expect(drawn).toBeLessThan(60)
    expect(screen.getByText("TARGET 1")).toBeInTheDocument()
    expect(screen.queryByText("TARGET 400")).not.toBeInTheDocument()
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
