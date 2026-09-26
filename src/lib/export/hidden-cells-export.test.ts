/**
 * AQU-1423, at the producer/consumer seam AGENTS.md rule 12 asks for: real
 * `CellData` carrying the hidden flag, through the real scoping step, into the
 * REAL exporters.
 *
 * Why the unit test on `validation-scope` is not enough on its own. That one
 * proves the predicate drops the right element of an array. What a partner
 * actually receives depends on what each exporter does with the array it is
 * handed, and the failure mode here is not a missing cell — it is a PRESENT one
 * in the wrong language. Every monolingual exporter falls back to
 * `translated || effectiveSourceText(cell)`, so a hidden cell that survives
 * scoping does not come out blank: it comes out in the SOURCE language, as a
 * seamless-looking line in the delivered file. Nothing downstream would flag it.
 *
 * So each assertion below looks for the hidden cell's source text as well as its
 * translation, and checks its neighbours are untouched — the shape of the bug
 * AQU-752 was on the Codex side.
 */

import { describe, it, expect } from "vitest"
import { exportVtt } from "./exporters/vtt"
import { exportSrt } from "./exporters/srt"
import { exportCsv } from "./exporters/csv"
import { exportTsv } from "./exporters/tsv"
import { exportPlainTextStructured } from "./exporters/plaintext"
import { exportMarkdownStructured } from "./exporters/markdown"
import { exportXliff12Structured } from "./exporters/xliff12-structured"
import { exportTmxStructured } from "./exporters/tmx-structured"
import { scopeCellsForExport, dropHiddenCells } from "./validation-scope"
import type { CellData } from "@/hooks/useCells"

/** `CellData & { hidden }` rather than `CellData` alone: the field arrives with
 *  AQU-1422, and writing the intersection here keeps this suite compiling — and
 *  meaningful — on either side of that merge. */
type ExportCell = CellData & { hidden?: boolean }

function cell(over: Partial<ExportCell>): ExportCell {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "", group: "",
    type: "verse", status: "validated", validationStatus: "full",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    ...over,
  } as ExportCell
}

/** Three timed lines, the middle one parked. Distinct, greppable strings on both
 *  sides, because "absent" has to mean absent in EITHER language. */
const CELLS: ExportCell[] = [
  cell({ id: "c1", original: "SOURCE ONE", translated: "TARGET ONE", startTime: 0, endTime: 1 }),
  cell({
    id: "c2", original: "SOURCE PARKED", translated: "TARGET PARKED",
    startTime: 1, endTime: 2, hidden: true,
  }),
  cell({ id: "c3", original: "SOURCE THREE", translated: "TARGET THREE", startTime: 2, endTime: 3 }),
]

const scoped = (mode: "current" | "validated-only" = "current") => scopeCellsForExport(CELLS, mode)

const text = (b: Blob) => b.text()

/** Both languages, for the reason in the file header. */
async function expectParkedAbsent(blob: Blob): Promise<string> {
  const out = await text(blob)
  expect(out).not.toContain("TARGET PARKED")
  expect(out).not.toContain("SOURCE PARKED")
  return out
}

describe("hidden cells leave the text exporters (AQU-1423)", () => {
  it("omits the parked line from plain text and Markdown", async () => {
    for (const build of [exportPlainTextStructured, exportMarkdownStructured]) {
      const out = await expectParkedAbsent(build(scoped()))
      expect(out).toContain("TARGET ONE")
      expect(out).toContain("TARGET THREE")
    }
  })

  it("omits the parked row from CSV and TSV", async () => {
    for (const build of [exportCsv, exportTsv]) {
      const out = await expectParkedAbsent(build(scoped()))
      expect(out).toContain("TARGET ONE")
    }
  })

  it("omits the parked unit from XLIFF and TMX", async () => {
    const xliff = await expectParkedAbsent(exportXliff12Structured(scoped(), "en", "es"))
    expect(xliff).toContain("TARGET ONE")
    const tmx = await expectParkedAbsent(exportTmxStructured(scoped(), "en-US", "es-ES"))
    expect(tmx).toContain("TARGET ONE")
  })

  it("omits the parked cue from SRT and VTT, and leaves the others' timings alone", async () => {
    const srt = await expectParkedAbsent(exportSrt(scoped()))
    const vtt = await expectParkedAbsent(exportVtt(scoped(), undefined))
    // The surviving cues keep THEIR OWN clock. A cue index that renumbers is
    // fine (SRT numbers are positional); a timestamp that shifts is not — it
    // would desynchronise the whole file from the audio.
    expect(srt).toContain("00:00:00,000 --> 00:00:01,000")
    expect(srt).toContain("00:00:02,000 --> 00:00:03,000")
    expect(srt).not.toContain("00:00:01,000 --> 00:00:02,000")
    expect(vtt).toContain("00:00:02.000 --> 00:00:03.000")
  })

  it("keeps the parked line out under validated-only too", async () => {
    // It is VALIDATED here, so only the hidden predicate can drop it — which is
    // the point: hiding overrules the validation rule rather than riding on it.
    await expectParkedAbsent(exportPlainTextStructured(scoped("validated-only")))
  })

  it("keeps the parked cue out of the audio-cue path, which skips the content mode", async () => {
    // The cues are exported straight from the sibling read, bypassing
    // `scopeCellsForExport` — so they need the hidden filter of their own, and a
    // regression here is invisible to every assertion above.
    await expectParkedAbsent(exportSrt(dropHiddenCells(CELLS)))
  })

  it("shows the cell again and it is back in every format", async () => {
    // The reversibility promise, at the delivered-file level. Same array, flag
    // cleared, and the line returns with its own timing.
    const shown = CELLS.map((c) => ({ ...c, hidden: false }))
    const srt = await text(exportSrt(scopeCellsForExport(shown, "current")))
    expect(srt).toContain("TARGET PARKED")
    expect(srt).toContain("00:00:01,000 --> 00:00:02,000")
    expect(await text(exportCsv(scopeCellsForExport(shown, "current")))).toContain("TARGET PARKED")
  })

  it("exports a file with nothing parked byte-identically", async () => {
    // The regression that would matter most: this change must be a no-op on
    // every project that has never hidden a cell.
    const visible = CELLS.filter((c) => c.hidden !== true)
    expect(await text(exportSrt(scopeCellsForExport(visible, "current"))))
      .toBe(await text(exportSrt(visible)))
    expect(await text(exportTsv(scopeCellsForExport(visible, "current"))))
      .toBe(await text(exportTsv(visible)))
  })
})
