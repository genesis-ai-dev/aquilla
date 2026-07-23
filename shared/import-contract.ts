/**
 * Runtime-neutral contract shared by the SPA and worker import gateways.
 *
 * Keep this module free of browser, React, Node, and Cloudflare dependencies so
 * both TypeScript projects compile the exact same manifest vocabulary. Parser
 * implementations remain adapters behind this contract; model-produced code
 * may be retained as inert provenance but is never executed by this contract.
 */

export const NORMALIZED_IMPORT_VERSION = 1 as const
/** Maximum retained source length for an isolated model-produced parser. */
export const MAX_SANDBOX_PROGRAM_CHARS = 60_000

/**
 * Largest immutable source/package artifact accepted by the browser import
 * path. Kept below Cloudflare's 100 MB request ceiling; workers stream these
 * bytes directly to R2 instead of buffering them in isolate memory.
 */
export const MAX_SOURCE_ARTIFACT_BYTES = 95 * 1024 * 1024

/**
 * Largest source artifact a worker may materialize in memory. Inline legacy
 * imports and uploads without streaming metadata must stay below this limit.
 */
export const MAX_BUFFERED_SOURCE_ARTIFACT_BYTES = 50 * 1024 * 1024

export const ROUND_TRIP_FIDELITIES = [
  "native",
  "verified-recipe",
  "content-only",
  "preserved-only",
] as const

export type RoundTripFidelity = (typeof ROUND_TRIP_FIDELITIES)[number]

/**
 * Source-artifact formats retained by importers. This is deliberately shared
 * by the browser and sync worker so adding an importer cannot silently fall
 * back to a `.bin` R2 object, the wrong content type, or an overstated
 * round-trip guarantee on one side of the upload boundary.
 *
 * Unknown agent-assisted originals remain accepted; callers use the explicit
 * `custom-original` format for those bytes and retain the real filename in
 * artifact metadata.
 */
export const SOURCE_ARTIFACT_FORMATS = {
  docx: { extension: "docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", defaultFidelity: "native" },
  pptx: { extension: "pptx", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", defaultFidelity: "native" },
  xlsx: { extension: "xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", defaultFidelity: "content-only" },
  usfm: { extension: "usfm", contentType: "text/plain; charset=utf-8", defaultFidelity: "native" },
  usx: { extension: "usx", contentType: "application/xml; charset=utf-8", defaultFidelity: "content-only" },
  md: { extension: "md", contentType: "text/markdown; charset=utf-8", defaultFidelity: "content-only" },
  txt: { extension: "txt", contentType: "text/plain; charset=utf-8", defaultFidelity: "content-only" },
  html: { extension: "html", contentType: "text/html; charset=utf-8", defaultFidelity: "content-only" },
  json: { extension: "json", contentType: "application/json; charset=utf-8", defaultFidelity: "content-only" },
  po: { extension: "po", contentType: "text/x-gettext-translation; charset=utf-8", defaultFidelity: "content-only" },
  properties: { extension: "properties", contentType: "text/plain; charset=utf-8", defaultFidelity: "content-only" },
  vtt: { extension: "vtt", contentType: "text/vtt; charset=utf-8", defaultFidelity: "content-only" },
  srt: { extension: "srt", contentType: "application/x-subrip; charset=utf-8", defaultFidelity: "content-only" },
  sbv: { extension: "sbv", contentType: "text/plain; charset=utf-8", defaultFidelity: "content-only" },
  xliff: { extension: "xlf", contentType: "application/xliff+xml", defaultFidelity: "content-only" },
  tmx: { extension: "tmx", contentType: "application/xml", defaultFidelity: "content-only" },
  csv: { extension: "csv", contentType: "text/csv; charset=utf-8", defaultFidelity: "content-only" },
  tsv: { extension: "tsv", contentType: "text/tab-separated-values; charset=utf-8", defaultFidelity: "content-only" },
  obs: { extension: "md", contentType: "text/markdown; charset=utf-8", defaultFidelity: "content-only" },
  "paratext-project": { extension: "zip", contentType: "application/zip", defaultFidelity: "preserved-only" },
  "custom-original": { extension: "bin", contentType: "application/octet-stream", defaultFidelity: "content-only" },
  "macula-tsv": { extension: "tsv", contentType: "text/tab-separated-values; charset=utf-8", defaultFidelity: "content-only" },
  "tn-tsv": { extension: "tsv", contentType: "text/tab-separated-values; charset=utf-8", defaultFidelity: "content-only" },
  ebible: { extension: "txt", contentType: "text/plain; charset=utf-8", defaultFidelity: "content-only" },
  helloao: { extension: "json", contentType: "application/json; charset=utf-8", defaultFidelity: "content-only" },
  "obs-package": { extension: "json", contentType: "application/json; charset=utf-8", defaultFidelity: "content-only" },
  "sdbh-master": { extension: "json", contentType: "application/json; charset=utf-8", defaultFidelity: "preserved-only" },
  "sdbh-localized": { extension: "json", contentType: "application/json; charset=utf-8", defaultFidelity: "preserved-only" },
} as const satisfies Record<string, {
  extension: string
  contentType: string
  defaultFidelity: RoundTripFidelity
}>

export type SourceArtifactFormat = keyof typeof SOURCE_ARTIFACT_FORMATS

export function sourceArtifactDescriptor(format: string): {
  extension: string
  contentType: string
  defaultFidelity: RoundTripFidelity
} {
  return format in SOURCE_ARTIFACT_FORMATS
    ? SOURCE_ARTIFACT_FORMATS[format as SourceArtifactFormat]
    : {
        extension: "bin",
        contentType: "application/octet-stream",
        defaultFidelity: "content-only",
      }
}

export const IMPORT_UNIT_KINDS = [
  "verse",
  "heading",
  "paratext",
  "paragraph",
  "list",
  "blockquote",
  "cue",
  "segment",
  "media",
  "other",
] as const

export type ImportUnitKind = (typeof IMPORT_UNIT_KINDS)[number]

export type ImportAddress =
  | {
      scheme: "scripture"
      book: string
      chapter: number
      verse: string
    }
  | {
      scheme: "scripture-structure"
      book: string
      chapter: number | null
      marker: string
      occurrence: number
    }
  | {
      scheme: "document"
      memberPath: string
      blockPath: string
      segment: number
    }
  | {
      scheme: "translation-unit"
      format: "xliff" | "tmx"
      unitId: string
      segmentId?: string
    }
  | {
      scheme: "timeline"
      cue: number
      startMs?: number
      endMs?: number
    }
  | {
      scheme: "sequence"
      index: number
    }
  | {
      scheme: "custom"
      recipeId: string
      record: number
    }

export type ImportSourceLocator =
  | {
      kind: "usfm"
      ref: string
      marker: string
      occurrence?: number
    }
  | {
      kind: "package-block"
      memberPath: string
      blockPath: string
      segment: number
    }
  | {
      kind: "translation-unit"
      format: "xliff" | "tmx"
      unitId: string
      segmentId?: string
    }
  | {
      kind: "cue"
      index: number
      startMs?: number
      endMs?: number
    }
  | {
      kind: "sequence"
      index: number
    }
  | {
      kind: "recipe"
      recipeId: string
      record: number
      field?: string
    }

/**
 * Versioned import provenance. Deterministic/declarative recipes describe
 * records. A sandbox-program recipe may retain model-produced parser code so
 * the exact interpretation can be audited and considered for later controlled
 * promotion. Retained programs are never reused or executed automatically and
 * are only eligible to run in the isolated, default-deny import sandbox.
 */
export interface DeclarativeImportRecipe {
  version: typeof NORMALIZED_IMPORT_VERSION
  id: string
  name: string
  inputFormat: string
  strategy: "records" | "sandbox-program"
  config: Record<string, unknown>
  proposedBy: "ai" | "user"
  /** Present only for sandbox-program recipes. Never execute in the browser,
   * auth worker, sync worker, or export worker. */
  program?: {
    language: "python" | "javascript"
    source: string
    sha256: string
  }
  /** Required before a caller may claim verified-recipe round-trip fidelity. */
  roundTripVerified?: boolean
}

export interface NormalizedImportSummary {
  version: typeof NORMALIZED_IMPORT_VERSION
  profileId: string
  profileVersion: string
  deterministic: boolean
  fidelity: RoundTripFidelity
  unitCount: number
  warningCounts: Partial<Record<string, number>>
  /** True when at least one imported unit has a canonical Scripture address.
   *  This describes the content without changing the source file format, so
   *  CSV/XLSX/custom imports can receive Scripture navigation while retaining
   *  their original round-trip/export path. Absent on older manifests. */
  hasScriptureContent?: true
  recipe?: DeclarativeImportRecipe
}
