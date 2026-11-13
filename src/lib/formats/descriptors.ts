// The format table (AQU-2384) — pure data, no parser imports.
//
// This is the half of the registry that ALL THREE import environments share:
// the browser, the parse Web Worker (`../parsers/parse.worker.ts`), and the
// sync-worker's Agent API import route (`sync-worker/src/external/
// import-parse-core.ts`). It is importable by every one of them because it
// imports nothing but types — the moment it reached into `../parsers/html` it
// would drag `DOMParser` into a Cloudflare Worker and the route would throw.
//
// Implementations hang off these descriptors in `./registry.ts`, which is the
// browser/test layer. Keeping the TABLE here and the CODE there is what makes
// "one registry" true rather than aspirational: `runtime.parse` is the single
// declaration of which formats a server can parse: `./registry.test.ts` fails
// if the parse core's routing set disagrees with it, and
// `sync-worker/src/__tests__/format-descriptors-drift.test.ts` fails if the
// sync-worker's two tables do.

import type { FormatRuntimes, RoundTripFidelity } from "./contract"

export interface FormatDescriptor {
  readonly id: string
  /** Lower-case, no leading dot. First entry is the canonical extension. */
  readonly extensions: readonly string[]
  readonly walkVersion: number
  readonly runtime: FormatRuntimes
  readonly fidelity: RoundTripFidelity
}

/**
 * The formats wrapped onto the contract so far. DOCX, PPTX, IDML, HTML,
 * XLIFF, SRT and VTT first (AQU-2384); the rest of `../parsers/` keeps working
 * exactly as it does today and gets wrapped in later tickets, so this table
 * being short is the plan, not an omission.
 *
 * `walkVersion` starts at 1 for every format and is bumped only when a walk
 * changes which units it emits or how it addresses them — a skeleton carries
 * the version it was parsed with so a stale export fails loudly instead of
 * writing translations into the wrong blocks.
 */
export const FORMAT_DESCRIPTORS: readonly FormatDescriptor[] = [
  {
    id: "docx",
    extensions: ["docx"],
    walkVersion: 1,
    // Parses through the DOM-free xml-lite reader — the one binary format the
    // sync-worker can parse. Builds through docx-runs, which needs DOMParser.
    runtime: { parse: "universal", build: "dom" },
    fidelity: "payload",
  },
  {
    id: "pptx",
    extensions: ["pptx"],
    walkVersion: 1,
    runtime: { parse: "dom", build: "dom" },
    fidelity: "payload",
  },
  {
    id: "idml",
    extensions: ["idml"],
    walkVersion: 1,
    runtime: { parse: "dom", build: "dom" },
    fidelity: "payload",
  },
  {
    id: "html",
    extensions: ["html", "htm"],
    walkVersion: 1,
    runtime: { parse: "dom", build: "dom" },
    fidelity: "payload",
  },
  {
    id: "xliff",
    extensions: ["xliff", "xlf"],
    walkVersion: 1,
    // The mirror image of docx: a DOMParser parse, a pure-string build.
    runtime: { parse: "dom", build: "universal" },
    fidelity: "regenerative",
  },
  {
    id: "srt",
    extensions: ["srt"],
    walkVersion: 1,
    runtime: { parse: "universal", build: "universal" },
    fidelity: "regenerative",
  },
  {
    id: "vtt",
    extensions: ["vtt"],
    walkVersion: 1,
    runtime: { parse: "universal", build: "universal" },
    fidelity: "regenerative",
  },
]

/**
 * Extension → descriptor, built from the table so the two can never disagree.
 *
 * Split out as a pure derivation over its input (the way
 * `partners/registry.ts` splits `integrationsFrom`) so the duplicate-extension
 * case is directly testable without mutating the real table.
 */
export function extensionIndexFrom(
  descriptors: readonly FormatDescriptor[],
): ReadonlyMap<string, FormatDescriptor> {
  const index = new Map<string, FormatDescriptor>()
  for (const descriptor of descriptors) {
    for (const extension of descriptor.extensions) {
      const existing = index.get(extension)
      if (existing) {
        throw new Error(
          `format extension ".${extension}" is claimed by both "${existing.id}" and "${descriptor.id}"`,
        )
      }
      index.set(extension, descriptor)
    }
  }
  return index
}

const EXTENSION_INDEX = extensionIndexFrom(FORMAT_DESCRIPTORS)

/** Strip a leading dot and case so `".DOCX"`, `"docx"` and `"Docx"` all hit. */
export function normalizeExtension(raw: string): string {
  return raw.trim().replace(/^\./, "").toLowerCase()
}

/** The extension of a file name, normalized. Empty string when it has none. */
export function extensionOfFileName(fileName: string): string {
  const match = /\.([^.\\/]+)$/.exec(fileName.trim())
  return match ? normalizeExtension(match[1]) : ""
}

export function descriptorForExtension(extension: string): FormatDescriptor | undefined {
  return EXTENSION_INDEX.get(normalizeExtension(extension))
}

export function descriptorForFileName(fileName: string): FormatDescriptor | undefined {
  return descriptorForExtension(extensionOfFileName(fileName))
}

export function descriptorById(id: string): FormatDescriptor | undefined {
  return FORMAT_DESCRIPTORS.find((descriptor) => descriptor.id === id)
}

/**
 * Formats whose PARSE needs no DOM — the ones a Cloudflare Worker or the parse
 * Web Worker may run. The sync-worker's server-parseable table is checked
 * against this in `sync-worker/src/__tests__/format-descriptors-drift.test.ts`.
 */
export function universallyParseableFormatIds(): readonly string[] {
  return FORMAT_DESCRIPTORS.filter((d) => d.runtime.parse === "universal").map((d) => d.id)
}

/** Formats whose parse is main-thread only (`CLIENT_ONLY_FORMATS` territory). */
export function domOnlyParseFormatIds(): readonly string[] {
  return FORMAT_DESCRIPTORS.filter((d) => d.runtime.parse === "dom").map((d) => d.id)
}
