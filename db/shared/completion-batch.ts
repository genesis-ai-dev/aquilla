// Completion batch size (AQU-586) — the project's configured "one human-review
// package" size, resolved SERVER-side from the project_settings blob.
//
// The formula is deliberately duplicated from the SPA's
// `src/lib/workspace-actions/registry.ts` (`completionBatchSizeFor`) rather
// than imported: `src/` is a browser bundle with its own tsconfig root and
// never imports from `db/`. Same default, same clamp — mirrors the way the
// credits formula is duplicated across workers (see sync-worker/src/credits.ts).
//
// Dependency-free so BOTH workers can import it: sync-worker enforces it as the
// DraftCells per-changeset cell cap (AQU-1186), auth-worker passes it to the
// drafting pipeline as its per-call ceiling.

/** Default package size when the project hasn't customized it. */
export const DEFAULT_COMPLETION_BATCH_SIZE = 10

/** Ceiling — a bad stored value can never request an unbounded package. */
export const MAX_COMPLETION_BATCH_SIZE = 50

/**
 * Resolve the configured batch size from a project's settings blob.
 *
 * The SPA writes this key under `completionSettings.completionBatchSize`;
 * both that nested shape and a top-level `completionBatchSize` are accepted so
 * the server reads the same number regardless of which surface stored it.
 * Anything absent, non-numeric, or non-positive falls back to the default.
 */
export function completionBatchSizeFromSettings(settings: Record<string, unknown> | null | undefined): number {
  const nested = settings?.completionSettings
  const fromNested =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>).completionBatchSize
      : undefined
  const raw = fromNested ?? settings?.completionBatchSize
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.min(MAX_COMPLETION_BATCH_SIZE, Math.floor(raw))
  }
  return DEFAULT_COMPLETION_BATCH_SIZE
}
