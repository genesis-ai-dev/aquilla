/**
 * Format adapters for the round-trip scorer.
 *
 * NOT frozen — this file is the surface under test. It wires each corpus
 * format to Aquilla's real parser + exporter. Adding an adapter here (by
 * implementing the missing parser/exporter in src/) is how the round-trip
 * score goes up. The CHECK LOGIC (checks.ts, runner.test.ts, the CLI) is
 * frozen per F7 and never changes to accommodate an adapter.
 *
 * Modules that don't exist yet are loaded dynamically: a failed import means
 * "no adapter yet" and every file of that format scores as failing — the
 * honest baseline.
 *
 * Export convention: copy-source — every segment's target is its existing
 * target if non-empty, else the source text (Matecat's draft behavior). The
 * scorer relies on this to verify structure without caring about translation
 * content.
 */
import type { CellData } from "@/hooks/useCells"
import type { TranslatableString } from "@/lib/parsers/types"
import { parseXliff } from "@/lib/parsers/xliff"
import { parseTmx } from "@/lib/parsers/tmx"
import { parseCsvBilingual } from "@/lib/parsers/csv-bilingual"
import { extractPlaintextStrings } from "@/lib/parsers/plaintext"
import { extractMarkdownStrings } from "@/lib/parsers/markdown"
import { extractSrtStrings, extractVttStrings } from "@/lib/parsers/subtitle"
import { extractDocxStrings } from "@/lib/parsers/docx"
import { extractPptxStrings } from "@/lib/parsers/pptx"
import { parseXlsxToSheets } from "@/lib/parsers/spreadsheet"
import { exportXliff } from "@/lib/export/exporters/xliff"
import { exportTmx } from "@/lib/export/exporters/tmx"
import { exportCsv } from "@/lib/export/exporters/csv"
import { exportTsv } from "@/lib/export/exporters/tsv"
import { exportPlainTextStructured } from "@/lib/export/exporters/plaintext"
import { exportMarkdownStructured } from "@/lib/export/exporters/markdown"
import { exportVttStructured } from "@/lib/export/exporters/vtt-structured"
import { exportSrt } from "@/lib/export/exporters/srt"
import { exportDocx } from "@/lib/export/exporters/docx"

export interface AdapterSegment {
  source: string
  target: string
  startMs?: number
  endMs?: number
}

export interface FormatAdapter {
  parse(bytes: Uint8Array, name: string): Promise<AdapterSegment[]>
  /** Copy-source export of the parsed file back into its own format. Absent = not implemented yet. */
  export?(bytes: Uint8Array, name: string): Promise<Uint8Array>
}

const dec = new TextDecoder()
const text = (b: Uint8Array): string => dec.decode(b)
const toBytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer())
const buf = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

const toSegments = (strings: TranslatableString[]): AdapterSegment[] =>
  strings.map((s) => ({
    source: s.original,
    target: s.translated?.trim() ? s.translated : s.original,
    startMs: s.start != null ? Math.round(s.start * 1000) : undefined,
    endMs: s.end != null ? Math.round(s.end * 1000) : undefined,
  }))

/** Minimal CellData for the exporters (they only read these fields — same
 *  convention as src/lib/parsers/cat-roundtrip.test.ts). */
const toCells = (strings: TranslatableString[]): CellData[] =>
  strings.map(
    (s, i) =>
      ({
        id: s.id || `seg-${i}`,
        fileId: "corpus-file",
        original: s.original,
        originalHtml: s.originalHtml,
        translated: s.translated?.trim() ? s.translated : s.original,
        group: s.group || s.id || `seg-${i}`,
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

export async function buildAdapters(): Promise<Record<string, FormatAdapter>> {
  const adapters: Record<string, FormatAdapter> = {
    xliff12: {
      parse: async (b) => toSegments(parseXliff(text(b))),
      export: async (b) => toBytes(exportXliff(toCells(parseXliff(text(b))), "en-US", "fr-FR")),
    },
    xliff20: {
      parse: async (b) => toSegments(parseXliff(text(b))),
    },
    tmx: {
      parse: async (b) => toSegments(parseTmx(text(b))),
      export: async (b) => toBytes(exportTmx(toCells(parseTmx(text(b))), "en-US", "fr-FR")),
    },
    csv: {
      parse: async (b) => toSegments(parseCsvBilingual(text(b))),
      export: async (b) => toBytes(exportCsv(toCells(parseCsvBilingual(text(b))))),
    },
    tsv: {
      parse: async (b) => toSegments(parseCsvBilingual(text(b))),
      export: async (b) => toBytes(exportTsv(toCells(parseCsvBilingual(text(b))))),
    },
    txt: {
      parse: async (b) => toSegments(extractPlaintextStrings(text(b))),
      export: async (b) => toBytes(exportPlainTextStructured(toCells(extractPlaintextStrings(text(b))))),
    },
    md: {
      parse: async (b) => toSegments(extractMarkdownStrings(text(b))),
      export: async (b) => toBytes(exportMarkdownStructured(toCells(extractMarkdownStrings(text(b))))),
    },
    srt: {
      parse: async (b) => toSegments(extractSrtStrings(text(b))),
      export: async (b) => toBytes(exportSrt(toCells(extractSrtStrings(text(b))))),
    },
    vtt: {
      parse: async (b) => toSegments(extractVttStrings(text(b))),
      export: async (b) => toBytes(exportVttStructured(toCells(extractVttStrings(text(b))))),
    },
    docx: {
      parse: async (b) => toSegments(await extractDocxStrings(buf(b))),
      export: async (b) => {
        const result = await exportDocx(buf(b), toCells(await extractDocxStrings(buf(b))))
        return toBytes(result.blob)
      },
    },
    pptx: {
      parse: async (b) => toSegments(await extractPptxStrings(buf(b))),
    },
    xlsx: {
      parse: async (b) => {
        const sheets = await parseXlsxToSheets(buf(b))
        return sheets.flatMap((sheet) =>
          sheet.rows.flatMap((row) =>
            row.filter((v) => v && v.trim()).map((v) => ({ source: v, target: v })),
          ),
        )
      },
    },
  }

  // Formats whose parser/exporter modules don't exist yet get NO entry (or no
  // export fn) — the frozen runner scores them 'no-adapter'/'no-exporter'.
  // As each module lands in src/, add its wiring here (this file is not frozen).
  return adapters
}
