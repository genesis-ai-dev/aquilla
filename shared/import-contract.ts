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

export const ROUND_TRIP_FIDELITIES = [
  "native",
  "verified-recipe",
  "content-only",
  "preserved-only",
] as const

export type RoundTripFidelity = (typeof ROUND_TRIP_FIDELITIES)[number]

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
  recipe?: DeclarativeImportRecipe
}
