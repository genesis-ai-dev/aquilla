// AQU-2383: how faithful an UNTOUCHED export is to the file that was uploaded.
//
// Split out of `fidelity.ts`, which covers the two style concerns (block-style
// drift and inline-style simplification). This is the coarser question: not
// "did the styling survive" but "are these the same bytes the user gave us".
// `fidelity.ts` re-exports everything here, so callers can keep importing from
// either.
//
// The rule is that a target lane with no committed translation exports the
// stored upload verbatim, because there is nothing of our own to add and every
// rebuild risks changing something nobody asked us to change — quote style,
// attribute order, CRLF, a byte-order mark, zip member order.
//
// Not every format can hold that rule yet, and the honest thing is to say
// which. This registry is what the export UI and the Agent API read to answer
// "will an untouched export of this format come back unchanged?", and what a
// reviewer reads to see what is left to do.
//
// It is hand-maintained and therefore driftable: the last block of
// `untouched-export.soak.test.ts` locks it to what that soak actually proves,
// so a format cannot claim the rule without a test behind the claim. When a
// format learns the rule, move its entry and add the case in the same change.

/** How close an UNTOUCHED export of a format comes to the stored upload. */
export type ByteFidelityLevel =
  /** The stored upload's bytes are returned verbatim. */
  | "byte-identical"
  /** Rebuilt from cells: same content, no promise about the bytes. */
  | "rebuilt"
  /** No upload to return — the export is a report this app generates. */
  | "generated"

export interface ByteFidelityEntry {
  /** Import format id, as `file_source_blobs.format` records it. */
  format: string
  level: ByteFidelityLevel
  /** Where the guarantee comes from, or what is missing. One sentence. */
  note: string
}

/**
 * Per-format byte fidelity of an export with no committed translations.
 *
 * Keep this ordered by level, strongest first, so the gap is easy to read.
 */
export const UNTOUCHED_EXPORT_FIDELITY: readonly ByteFidelityEntry[] = [
  {
    format: "usfm",
    level: "byte-identical",
    note: "the lossless serializer reproduces the upload exactly when the export plan is empty, byte-order mark and CRLF included",
  },
  {
    format: "txt",
    level: "byte-identical",
    note: "the export route returns the stored blob when the lane has no translation, and restores the source's mark and line terminator when it does",
  },
  {
    format: "custom-original",
    level: "byte-identical",
    note: "never parsed, so the stored upload is always what is served",
  },
  {
    format: "docx",
    level: "byte-identical",
    note: "run reinsertion is a string splice into word/document.xml; when it splices nothing the uploaded package is returned instead of a re-zip",
  },
  {
    format: "pptx",
    level: "byte-identical",
    note: "slides are rewritten one at a time; when no slide changes the uploaded deck is returned instead of a re-zip",
  },
  {
    format: "idml",
    level: "rebuilt",
    note: "the round-trip engine re-serializes the package on every export, and the no-break repair pass rewrites it again — no untouched short-circuit yet",
  },
  {
    format: "srt",
    level: "rebuilt",
    note: "cues are rebuilt from cell timings and text; cue numbering, blank lines and the line terminator come from the exporter, not the upload",
  },
  {
    format: "vtt",
    level: "rebuilt",
    note: "cues are rebuilt as in srt, and the WEBVTT header, cue order and separators are the exporter's rather than the upload's",
  },
  {
    format: "xliff",
    level: "rebuilt",
    note: "the skeleton is reassembled from segment metadata, so attribute order and whitespace are the serializer's",
  },
  {
    format: "tmx",
    level: "rebuilt",
    note: "translation units are re-emitted from segment metadata, so attribute order and whitespace are the serializer's",
  },
  {
    format: "csv",
    level: "rebuilt",
    note: "quoting, delimiter and line terminator are chosen by the exporter rather than read off the upload",
  },
  {
    format: "tsv",
    level: "rebuilt",
    note: "quoting, delimiter and line terminator are the exporter's choices, as in csv",
  },
  {
    format: "md",
    level: "rebuilt",
    note: "block syntax is regenerated, so emphasis markers and list bullets normalize to the exporter's choices",
  },
  {
    format: "html",
    level: "rebuilt",
    note: "serialized from the block model, so tag case, attribute order and indentation are the exporter's",
  },
  {
    format: "xlsx",
    level: "generated",
    note: "written from scratch as a report; there is no uploaded workbook to return",
  },
]

const BY_FORMAT = new Map(UNTOUCHED_EXPORT_FIDELITY.map((e) => [e.format, e]))

/** The registry entry for an import format, or `undefined` if unrecorded. */
export function untouchedExportFidelity(format: string): ByteFidelityEntry | undefined {
  return BY_FORMAT.get(format)
}

/** Whether an untouched export of this format returns the upload's bytes. */
export function exportsUntouchedByteIdentical(format: string): boolean {
  return BY_FORMAT.get(format)?.level === "byte-identical"
}

/**
 * Formats that cannot yet hold the untouched-export rule — the remaining work,
 * as a list the UI can show and a reviewer can count.
 *
 * `generated` formats are excluded: they have no upload to be unfaithful to.
 */
export function formatsWithoutByteIdenticalExport(): readonly ByteFidelityEntry[] {
  return UNTOUCHED_EXPORT_FIDELITY.filter((e) => e.level === "rebuilt")
}
