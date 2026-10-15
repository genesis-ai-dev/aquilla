/**
 * Format-agnostic content model. Every adapter (IDML, Markdown, JSON, …) maps
 * its native artifact into a ContentGraph of ContentUnits and back. Nothing in
 * src/core knows about any particular file format.
 */

/** Diagnostic surfaced by an adapter or the engine. Never silently dropped. */
export interface Diagnostic {
  readonly code: string
  readonly severity: "info" | "warning" | "error"
  readonly message: string
  readonly unitId?: string
  readonly path?: string
}

/**
 * One translatable unit (a paragraph, table cell, heading, string resource…).
 *
 * `tagged` is the canonical source text in the inline-tag notation used across
 * the system (see core/tagged.ts): formatting runs are `<gN>…</gN>` and protected
 * inline objects are `<xN/>`. Adapters own the mapping from tags back to native
 * structure, so the translator never sees native markup.
 */
export interface ContentUnit {
  /** Stable identity across source revisions. Empty until reconciliation assigns it. */
  logicalId: string
  /** Native container identity (story, table cell, file…). Reconciliation aligns within scopes first. */
  readonly scope: string
  /** Native per-unit identifier when the format has a trustworthy one (JSON key, InDesign Self id). */
  readonly nativeAnchor?: string
  /** Adapter-specific locator for patching this unit in the *current* revision. */
  readonly structuralPath: string
  /** Order inside the scope. */
  readonly ordinal: number
  readonly kind: string
  readonly tagged: string
  /** Text with tags removed — used for similarity, search and context matching. */
  readonly plain: string
  /** Hash of `tagged`: a formatting change is a content change. */
  readonly contentHash: string
  /** Adapter hints (paragraph style, point size, story id…). Not part of identity. */
  readonly meta?: Readonly<Record<string, string | number>>
}

export interface ContentGraph {
  readonly docId: string
  readonly format: string
  /** Hash of the exact source bytes. */
  readonly revision: string
  readonly units: ContentUnit[]
  readonly diagnostics: Diagnostic[]
}

export type IdentityStatus =
  | "unchanged"
  | "modified"
  | "moved"
  | "inserted"
  | "split"
  | "merged"
  | "ambiguous"

export interface IdentityMatch {
  /** Index into the current unit list. */
  readonly index: number
  readonly logicalId: string
  readonly status: IdentityStatus
  /** Previous logical ids this unit descends from (1 for modified/moved, n for merged, candidates for ambiguous). */
  readonly predecessors: readonly string[]
  /** 0..1 similarity to the predecessor(s); 1 for exact matches. */
  readonly similarity: number
  /** How the match was found — useful for audit and for tuning. */
  readonly via: "native-anchor" | "sequence" | "exact-elsewhere" | "fuzzy" | "split" | "merge" | "asserted" | "none"
}

export interface IdentityMapping {
  readonly matches: IdentityMatch[]
  /** Previous ids with no descendant in the current revision. */
  readonly deleted: string[]
}

export type Authority = "agent" | "human" | "approved"

/** Authority rank used by the patch engine. Approved > human > agent. */
export const authorityRank = (a: Authority): number => (a === "approved" ? 3 : a === "human" ? 2 : 1)

/**
 * A change to the target-language state of one unit (spec §4.4). Patches carry
 * preconditions (`expectedRevision`) and authority, and are idempotent by
 * `operationId`.
 */
export interface ContentPatch {
  readonly operationId: string
  readonly logicalId: string
  /** Hash of the target content the patch was computed against, or "none" when the unit had no target content. */
  readonly expectedRevision: string
  readonly targetLocale: string
  readonly operation: "replace" | "insert" | "delete"
  readonly content?: string
  readonly authority: Authority
  /** An agent patch may replace human content only when it is explicitly a revision of it after a source change. */
  readonly revisesHuman?: boolean
}

/** The target side of one unit, as last published / currently intended. */
export interface TargetUnitState {
  readonly content: string
  readonly contentHash: string
  readonly authority: Authority
}

export interface PatchRejection {
  readonly patch: ContentPatch
  readonly reason: "stale" | "unauthorized" | "missing-content" | "unknown-unit"
  readonly detail: string
}

export interface PatchResult {
  readonly state: ReadonlyMap<string, TargetUnitState>
  readonly applied: ContentPatch[]
  readonly skipped: ContentPatch[]
  readonly rejected: PatchRejection[]
  /**
   * Every operation id this call decided on (applied, skipped or rejected).
   * Feeding it back as `processed` makes re-application a strict no-op: a
   * patch that lost a race stays lost, it is not re-evaluated later.
   */
  readonly processed: ReadonlySet<string>
}

export interface ValidationResult {
  readonly ok: boolean
  readonly diagnostics: Diagnostic[]
}
