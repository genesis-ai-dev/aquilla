// Acceptance tests for the text-family format rows of PARITY_MATRIX.yaml.
// Each test title carries the matrix row tag — parity:score maps titles → rows.
// Fixtures here are synthetic and independent of the eval corpus (F1).
import { describe, it, expect } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { TranslatableString } from "@/lib/parsers/types"
import { extractPlaintextStrings } from "@/lib/parsers/plaintext"
import { extractMarkdownStrings } from "@/lib/parsers/markdown"
import { extractSrtStrings, extractVttStrings } from "@/lib/parsers/subtitle"
import { parseCsvBilingual } from "@/lib/parsers/csv-bilingual"
import { exportPlainTextStructured } from "@/lib/export/exporters/plaintext"
import { exportMarkdownStructured } from "@/lib/export/exporters/markdown"
import { exportSrt } from "@/lib/export/exporters/srt"
import { exportVttStructured } from "@/lib/export/exporters/vtt-structured"
import { exportCsv } from "@/lib/export/exporters/csv"
import { exportTsv } from "@/lib/export/exporters/tsv"

const toCells = (strings: TranslatableString[], translate?: (s: string) => string): CellData[] =>
  strings.map(
    (s, i) =>
      ({
        id: s.id || `seg-${i}`,
        fileId: "f",
        original: s.original,
        translated: translate ? translate(s.original) : s.translated,
        group: s.group || s.id,
        context: s.context ?? "",
        type: s.type,
        status: "unvalidated",
        validationStatus: "unvalidated",
        activeValidators: [],
        validationHistory: [],
        history: [],
        threads: [],
        startTime: s.start,
        endTime: s.end,
        speaker: s.speaker,
      }) as unknown as CellData,
  )

const tr = (s: string): string => `«${s}»`

describe("text-family round-trip", () => {
  it("[fmt.txt.roundtrip] plain text keeps paragraph structure and falls back to source", async () => {
    const src = "First paragraph sentence one. Sentence two.\n\nSecond paragraph.\n\nThird — untranslated."
    const strings = extractPlaintextStrings(src)
    const cells = toCells(strings, undefined) // no translations at all
    cells[0].translated = "Premier paragraphe phrase un."
    const out = await exportPlainTextStructured(cells).text()
    const reparsed = extractPlaintextStrings(out)
    // paragraph structure preserved
    const paraCount = (s: string): number => s.split(/\n\n+/).filter((p) => p.trim()).length
    expect(paraCount(out)).toBe(paraCount(src))
    // untranslated paragraphs fall back to source text
    expect(out).toContain("Second paragraph.")
    expect(out).toContain("Third — untranslated.")
    expect(out).toContain("Premier paragraphe phrase un.")
    expect(reparsed.length).toBe(strings.length)
  })

  it("[fmt.csv.roundtrip] bilingual CSV survives quotes, commas and embedded newlines", async () => {
    const src = 'source,target\n"Hello, ""world""","Bonjour, ""monde"""\n"Line1\nLine2",Ligne\nPlain,Simple\n'
    const strings = parseCsvBilingual(src)
    const out = await exportCsv(toCells(strings)).text()
    const reparsed = parseCsvBilingual(out)
    expect(reparsed.map((s) => s.original)).toEqual(strings.map((s) => s.original))
    expect(reparsed.map((s) => s.translated)).toEqual(strings.map((s) => s.translated))
  })

  it("[fmt.tsv.roundtrip] bilingual TSV survives round-trip with identical values", async () => {
    const src = "source\ttarget\nHello world\tBonjour le monde\nSecond row\t\n"
    const strings = parseCsvBilingual(src)
    const out = await exportTsv(toCells(strings, tr)).text()
    const reparsed = parseCsvBilingual(out)
    expect(reparsed.map((s) => s.original)).toEqual(strings.map((s) => s.original))
    expect(reparsed.map((s) => s.translated)).toEqual(strings.map((s) => s.original).map(tr))
  })

  it("[fmt.srt.roundtrip] SRT preserves cue count, order and millisecond timecodes", async () => {
    const src = "1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,250 --> 00:00:05,007\nTwo lines\nsecond line\n\n3\n01:02:03,004 --> 01:02:59,999\n<i>Tagged</i>\n"
    const strings = extractSrtStrings(src)
    expect(strings).toHaveLength(3)
    const out = await exportSrt(toCells(strings, tr)).text()
    const reparsed = extractSrtStrings(out)
    expect(reparsed).toHaveLength(3)
    expect(reparsed.map((s) => [s.start, s.end])).toEqual(strings.map((s) => [s.start, s.end]))
    expect(reparsed.map((s) => s.original)).toEqual(strings.map((s) => tr(s.original).replace(/\n/g, "\n")))
    // timecodes byte-precise
    expect(out).toContain("00:00:03,250 --> 00:00:05,007")
    expect(out).toContain("01:02:03,004 --> 01:02:59,999")
  })

  it("[fmt.vtt.roundtrip] VTT preserves header, timecodes and voice tags", async () => {
    const src = "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<v Ana>Hola</v>\n\n00:00:04.000 --> 00:00:06.250\nPlain cue\n"
    const strings = extractVttStrings(src)
    expect(strings).toHaveLength(2)
    expect(strings[0].speaker).toBe("Ana")
    const out = await exportVttStructured(toCells(strings, tr)).text()
    expect(out.startsWith("WEBVTT\n")).toBe(true)
    expect(out).toContain("<v Ana>«Hola»</v>")
    expect(out).toContain("00:00:04.000 --> 00:00:06.250")
    const reparsed = extractVttStrings(out)
    expect(reparsed).toHaveLength(2)
    expect(reparsed[0].speaker).toBe("Ana")
    expect(reparsed.map((s) => [s.start, s.end])).toEqual(strings.map((s) => [s.start, s.end]))
  })

  it("[fmt.md.roundtrip] markdown reconstructs headings, lists and blockquotes", async () => {
    const src = "# Title\n\nBody paragraph with text.\n\n## Section\n\n- item one\n- item two\n\n> a quote\n"
    const strings = extractMarkdownStrings(src)
    const out = await exportMarkdownStructured(toCells(strings, tr)).text()
    expect(out).toContain("# «Title»")
    expect(out).toContain("## «Section»")
    expect(out).toContain("- «item one»")
    expect(out).toContain("> «a quote»")
    const reparsed = extractMarkdownStrings(out)
    expect(reparsed.map((s) => s.type)).toEqual(strings.map((s) => s.type))
    expect(reparsed.map((s) => s.context)).toEqual(strings.map((s) => s.context))
  })
})
