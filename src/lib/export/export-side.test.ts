/**
 * AQU-1451: which side an export writes.
 *
 * The regression this guards is not "Source produces something" — it is that
 * Source produces the CURATED source and nothing else, through the very same
 * serializers the target side uses. So each case runs a real exporter over
 * side-swapped cells and reads the bytes, rather than asserting on the shape of
 * the intermediate array: a future exporter that starts preferring
 * `translatedHtml`, or a scoping change that lets a hidden cell back in, has to
 * fail here and not in somebody's delivered file.
 */
import { describe, it, expect } from "vitest"
import type { CellData } from "@/hooks/useCells"
import {
  DEFAULT_EXPORT_SIDE,
  applyExportSide,
  canExportSide,
  isBilingualFormat,
  sideAvailability,
} from "./export-side"
import { exportPlainTextStructured } from "./exporters/plaintext"
import { exportMarkdownStructured } from "./exporters/markdown"
import { exportSrt } from "./exporters/srt"
import { exportVtt } from "./exporters/vtt"
import { exportPlainTextDump } from "./exporters/plain-text-dump"
import { dropHiddenCells } from "./validation-scope"
import { extractVttStrings } from "@/lib/parsers/subtitle"

type Cell = CellData & { hidden?: boolean }

function cell(over: Partial<Cell>): Cell {
  return {
    id: "c",
    fileId: "f1",
    original: "",
    translated: "",
    context: "",
    group: "",
    type: "text",
    status: "unvalidated",
    ...over,
  } as Cell
}

const text = async (b: Blob): Promise<string> => await b.text()

/** One cue whose source was EDITED, one HIDDEN, one translated, one not. The
 *  shape the issue's test checklist describes, reused by every case below. */
const TIMED: Cell[] = [
  cell({ id: "c1", original: "Edited source line", translated: "La línea traducida", startTime: 0, endTime: 1 }),
  cell({ id: "c2", original: "Parked line", translated: "Línea aparcada", startTime: 1, endTime: 2, hidden: true }),
  cell({ id: "c3", original: "Third line", translated: "Tercera línea", startTime: 2, endTime: 3 }),
  cell({ id: "c4", original: "Untranslated line", translated: "", startTime: 3, endTime: 4 }),
]

/** What the dialog does for a Source export: hidden cells out, then the swap. */
const sourceCells = (cells: Cell[]): Cell[] => applyExportSide(dropHiddenCells(cells), "source")

describe("applyExportSide", () => {
  it("returns the caller's own array for the target side", () => {
    // Identity, not a copy: today's exports must stay byte-identical, and a
    // needless map would also invalidate the memoization around it.
    const cells = [cell({ id: "a", translated: "t" })]
    expect(applyExportSide(cells, "target")).toBe(cells)
  })

  it("puts each cell's effective source text where its translation was", () => {
    const [swapped] = applyExportSide([cell({ original: "Source", translated: "Target" })], "source")
    expect(swapped.translated).toBe("Source")
    expect(swapped.original).toBe("Source")
  })

  it("drops translatedHtml rather than carrying the target's rich text along", () => {
    // It is the TARGET value's twin. Left in place, any consumer preferring it
    // would write translation text into a file labelled Source.
    const [swapped] = applyExportSide(
      [cell({ original: "Source", translated: "Target", translatedHtml: "<p>Target</p>" })],
      "source",
    )
    expect(swapped.translatedHtml).toBeUndefined()
  })

  it("speaks a media section through its transcript, never its import filename", () => {
    // effectiveSourceText's rule (AQU-646): `original` holds the filename for a
    // media section, which is never legitimate source text.
    const withTranscript = cell({ medium: "media", original: "clip-07.mp4", transcription: "What was said" })
    const without = cell({ medium: "media", original: "clip-08.mp4" })
    const [a, b] = applyExportSide([withTranscript, without], "source")
    expect(a.translated).toBe("What was said")
    expect(b.translated).toBe("")
  })

  it("does not mutate the caller's cells", () => {
    const cells = [cell({ original: "Source", translated: "Target" })]
    applyExportSide(cells, "source")
    expect(cells[0].translated).toBe("Target")
  })
})

describe("sideAvailability / canExportSide", () => {
  it("offers both sides on the formats built in the browser", () => {
    for (const f of ["txt", "md", "srt", "vtt", "plain-text-dump"] as const) {
      expect(sideAvailability(f)).toBe("both")
      expect(canExportSide(f, "source")).toBe(true)
    }
  })

  it("marks the bilingual formats rather than offering them a choice", () => {
    for (const f of ["tsv", "csv", "xlf", "tmx"] as const) {
      expect(isBilingualFormat(f)).toBe(true)
      expect(sideAvailability(f)).toBe("bilingual")
      // Picking the format IS the choice; there is no source-only variant.
      expect(canExportSide(f, "source")).toBe(false)
    }
  })

  it("holds usfm/docx/pptx at 'pending' until their round-trip source lands", () => {
    // AQU-1449 (usfm) and AQU-1452 (docx/pptx) build the source side from the
    // original uploaded package. Until then the option is shown disabled, and
    // `canExportSide` is false so a stale selection cannot export Target under
    // a Source label.
    for (const f of ["usfm", "docx", "pptx"] as const) {
      expect(sideAvailability(f)).toBe("pending")
      expect(canExportSide(f, "source")).toBe(false)
    }
  })

  it("gives IDML, the metadata sheet and the audio exports no source option", () => {
    for (const f of ["idml", "metadata-csv", "audio-by-character", "audio-by-line", "audio-chapter", "character-sheets", "project-report", "sdbh-xml"] as const) {
      expect(sideAvailability(f)).toBe("target-only")
      expect(canExportSide(f, "source")).toBe(false)
    }
  })

  it("always allows the target side — it is the default and today's output", () => {
    expect(DEFAULT_EXPORT_SIDE).toBe("target")
    for (const f of ["usfm", "idml", "tsv", "vtt", "audio-by-line"] as const) {
      expect(canExportSide(f, "target")).toBe(true)
    }
  })
})

describe("the source side through the real exporters", () => {
  it("SRT: edited source in, hidden cue out, timings and cue numbering intact", async () => {
    const out = await text(exportSrt(sourceCells(TIMED)))
    expect(out).toContain("Edited source line")
    expect(out).toContain("Untranslated line")
    // The parked cue leaves the file entirely — marker and all.
    expect(out).not.toContain("Parked line")
    expect(out).not.toContain("Línea aparcada")
    // No translation text anywhere, even though every cue has one.
    expect(out).not.toContain("La línea traducida")
    // Cue numbers stay sequential over the gap the hidden cue left, and every
    // remaining cue keeps its own timing.
    expect(out).toContain("1\n00:00:00,000 --> 00:00:01,000")
    expect(out).toContain("2\n00:00:02,000 --> 00:00:03,000")
    expect(out).toContain("3\n00:00:03,000 --> 00:00:04,000")
  })

  it("VTT: same file, same timings, no target line", async () => {
    const out = await text(exportVtt(sourceCells(TIMED), undefined, {}))
    expect(out).toContain("WEBVTT")
    expect(out).toContain("Edited source line")
    expect(out).not.toContain("Parked line")
    expect(out).not.toContain("La línea traducida")
    expect(out).toContain("00:00:02.000 --> 00:00:03.000")
  })

  it("VTT: a source export is the same file whatever the active lane holds", async () => {
    // "Switching lanes does not change a Source export" — the acceptance
    // criterion, exercised by exporting the same cells under two different lane
    // values and diffing the bytes.
    const laneA = await text(exportVtt(sourceCells(TIMED), undefined, {}))
    const laneB = await text(
      exportVtt(sourceCells(TIMED.map((c) => ({ ...c, translated: `OTHER LANE ${c.id}` }))), undefined, {}),
    )
    expect(laneB).toBe(laneA)
  })

  it("txt: paragraphs regroup exactly as they do on the target side", async () => {
    const cells = [
      cell({ id: "a", group: "p1", original: "First half.", translated: "Primera." }),
      cell({ id: "b", group: "p1", original: "Second half.", translated: "Segunda." }),
      cell({ id: "c", group: "p2", original: "New paragraph.", translated: "Nuevo." }),
      cell({ id: "d", group: "p3", original: "Parked.", translated: "Aparcado.", hidden: true }),
    ]
    expect(await text(exportPlainTextStructured(sourceCells(cells))))
      .toBe("First half. Second half.\n\nNew paragraph.\n")
  })

  it("md: heading levels and list markers survive the swap", async () => {
    const cells = [
      cell({ id: "h", type: "heading", context: "Heading 2", original: "A Title", translated: "Un título" }),
      cell({ id: "l1", type: "list", original: "First item", translated: "Primero" }),
      cell({ id: "l2", type: "list", original: "Second item", translated: "Segundo" }),
    ]
    expect(await text(exportMarkdownStructured(sourceCells(cells))))
      .toBe("## A Title\n\n- First item\n- Second item\n")
  })

  it("plain-text dump: source lines, and the hidden one is not among them", async () => {
    const out = await text(exportPlainTextDump(sourceCells(TIMED), { includeRefs: false }))
    expect(out.split("\n")).toEqual(["Edited source line", "Third line", "Untranslated line"])
  })

  it("re-imports into a new project as the exporting file's VISIBLE source cells, one for one", async () => {
    // AGENTS.md #12: the producer's real output through its immediate consumer.
    // "Import the source export as the source of another project" is the whole
    // point of the feature, so the exporter's bytes go through the importer's
    // own parser rather than through a hand-built fixture.
    const parsed = extractVttStrings(await text(exportVtt(sourceCells(TIMED), undefined, {})))
    const visible = TIMED.filter((c) => !c.hidden)
    expect(parsed).toHaveLength(visible.length)
    expect(parsed.map((p) => p.original)).toEqual(visible.map((c) => c.original))
    // Timings included, and nothing arrives pre-translated.
    expect(parsed.map((p) => [p.start, p.end])).toEqual(visible.map((c) => [c.startTime, c.endTime]))
    expect(parsed.every((p) => p.translated === "")).toBe(true)
  })

  it("leaves the target side byte-identical to today's output", async () => {
    // The other half of the contract: adding a Side control must not move a
    // single byte of the existing exports.
    for (const build of [exportSrt, exportPlainTextStructured, exportMarkdownStructured] as const) {
      const today = await text(build(dropHiddenCells(TIMED)))
      const withSide = await text(build(applyExportSide(dropHiddenCells(TIMED), "target")))
      expect(withSide).toBe(today)
    }
  })
})
