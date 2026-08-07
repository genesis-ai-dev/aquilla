// Decision 2026-08-05: a document leaving the app must never carry a
// filename as source text. Media cells export their TRANSCRIPTION when there
// is one and BLANK when there isn't (effectiveSourceText); text cells are
// byte-identical to before. One suite pins the contract across every exporter
// that serializes source text.
import { describe, it, expect } from "vitest"
import { exportCsv } from "./csv"
import { exportTsv } from "./tsv"
import { exportXliff } from "./xliff"
import { exportTmx } from "./tmx"
import { exportSrt } from "./srt"
import { exportVtt } from "./vtt"
import { exportPlainText } from "./plaintext"
import { exportMarkdown } from "./markdown"
import type { CellData } from "@/hooks/useCells"

const FILENAME = "Day 12 - Colossians 3 vs 15-19.mp3"

function makeCell(overrides: Partial<CellData>): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "Hello world",
    translated: "Bonjour monde",
    context: "",
    group: "GEN 1:1",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  }
}

/** Untranscribed media section — `original` holds the import filename. */
const untranscribed = makeCell({
  id: "m1",
  group: "v1",
  medium: "media",
  original: FILENAME,
  translated: "Traduction une",
  startTime: 0,
  endTime: 3,
})

/** Transcribed media section — the transcript is the source text. */
const transcribed = makeCell({
  id: "m2",
  group: "v2",
  medium: "media",
  original: FILENAME,
  transcription: "And let the peace of Christ rule",
  translated: "Et que la paix du Christ règne",
  startTime: 3,
  endTime: 6,
})

/** Plain text cell — must export byte-identically to before. */
const textCell = makeCell({ id: "t1", group: "GEN 1:1" })

/** Untranslated media cell — the fallback-body formats must OMIT it rather
 *  than print the filename. */
const untranslatedMedia = makeCell({
  id: "m3",
  group: "v3",
  medium: "media",
  original: FILENAME,
  translated: "",
  startTime: 6,
  endTime: 9,
})

const CELLS = [textCell, untranscribed, transcribed, untranslatedMedia]

describe("exports never carry the filename as source text", () => {
  it("CSV: transcription when present, blank when not", async () => {
    const text = await exportCsv(CELLS).text()
    expect(text).not.toContain(FILENAME)
    expect(text).toContain("And let the peace of Christ rule")
    expect(text).toContain("Hello world")
    // The untranscribed row keeps its target with an empty source column.
    expect(text).toContain(",Traduction une")
  })

  it("TSV: same contract", async () => {
    const text = await exportTsv(CELLS).text()
    expect(text).not.toContain(FILENAME)
    expect(text).toContain("And let the peace of Christ rule")
    expect(text).toContain("\tTraduction une")
  })

  it("XLIFF: empty <source> for untranscribed media", async () => {
    const text = await exportXliff(CELLS).text()
    expect(text).not.toContain(FILENAME)
    expect(text).toContain("And let the peace of Christ rule")
  })

  it("TMX: untranscribed media cells drop out of the TU list entirely", async () => {
    const text = await exportTmx(CELLS).text()
    expect(text).not.toContain(FILENAME)
    expect(text).not.toContain("Traduction une") // its TU is gone, not blank
    expect(text).toContain("And let the peace of Christ rule")
    expect(text).toContain("Hello world")
  })

  it("SRT: untranslated media cues are omitted, not filename-filled", async () => {
    const text = await exportSrt(CELLS).text()
    expect(text).not.toContain(FILENAME)
    expect(text).toContain("Traduction une") // translated media cue survives
  })

  it("VTT: same contract", async () => {
    const text = await exportVtt(CELLS, undefined).text()
    expect(text).not.toContain(FILENAME)
    expect(text).toContain("Traduction une")
  })

  it("plain text / markdown: untranslated media paragraphs are omitted", async () => {
    for (const exporter of [exportPlainText, exportMarkdown]) {
      const text = await exporter(CELLS).text()
      expect(text).not.toContain(FILENAME)
    }
  })

  it("a transcribed but UNTRANSLATED media cue falls back to the transcription", async () => {
    const cell = makeCell({
      id: "m4",
      medium: "media",
      original: FILENAME,
      transcription: "spoken words",
      translated: "",
      startTime: 0,
      endTime: 2,
    })
    const text = await exportSrt([cell]).text()
    expect(text).toContain("spoken words")
    expect(text).not.toContain(FILENAME)
  })
})
