/**
 * Adapter contract (spec §4.1).
 *
 * The spec sketches `extract / reconcile / apply / validate`. Reconciliation is
 * deliberately *not* per-adapter here: it lives in src/core/reconcile.ts and
 * works on any ContentGraph. Adapters only supply what the core cannot know —
 * native scopes, native anchors, and how tags map back to native structure.
 * If a second format needed its own reconciliation engine, the platform
 * abstraction would have failed (spec §7 Phase 5); keeping it out of the
 * adapter contract makes that failure visible.
 */
import type { ContentGraph, Diagnostic, ValidationResult } from "../core/types.ts"

export interface RenderResult {
  readonly bytes: Uint8Array
  readonly diagnostics: Diagnostic[]
}

export interface MergeResult {
  readonly bytes: Uint8Array
  /** Members/regions where both sides changed and "theirs" (the edited target) was kept. */
  readonly conflicts: string[]
  /** Regions where the newly generated output was taken over the edited target's unchanged copy. */
  readonly takenOurs: string[]
}

export interface LayoutFinding {
  readonly scope: string
  readonly severity: "ok" | "tight" | "overset"
  readonly sourceFill: number
  readonly targetFill: number
  readonly expansion: number
  readonly detail: string
  readonly repair?: string
}

export interface ContentAdapter {
  readonly format: string
  readonly extensions: readonly string[]
  extract(bytes: Uint8Array, docId: string): ContentGraph
  /** Produce the target artifact from the *source* artifact and translations keyed by structuralPath. */
  render(source: Uint8Array, translations: ReadonlyMap<string, string>, options: { locale: string }): RenderResult
  /** Structural validation of an output against its source. */
  validate(source: Uint8Array, output: Uint8Array): ValidationResult
  /**
   * Three-way merge for when a person edited the published target outside the
   * system: base = what we published, theirs = the file as it is now, ours =
   * the newly rendered output. Optional: adapters without it fall back to
   * "never overwrite an edited target" (output is written beside it).
   */
  merge3?(base: Uint8Array, theirs: Uint8Array, ours: Uint8Array): MergeResult
  /** Optional layout assurance (fit/overset estimation). */
  layout?(source: Uint8Array, output: Uint8Array): LayoutFinding[]
}
