/**
 * Runtime-neutral contract shared by the SPA and worker import gateways.
 *
 * Keep this module free of browser, React, Node, and Cloudflare dependencies so
 * both TypeScript projects compile the exact same manifest vocabulary. Parser
 * implementations remain adapters behind this contract; model-produced code
 * is never part of it.
 */

export const NORMALIZED_IMPORT_VERSION = 1 as const

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

/** A constrained data recipe. It describes records; it cannot contain code. */
export interface DeclarativeImportRecipe {
  version: typeof NORMALIZED_IMPORT_VERSION
  id: string
  name: string
  inputFormat: string
  strategy: "records"
  config: Record<string, unknown>
  proposedBy: "ai" | "user"
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
