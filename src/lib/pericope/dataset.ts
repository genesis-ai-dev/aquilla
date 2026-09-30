import { indexSections, parseSectionCounts, type PericopeIndex } from "./sections"

/**
 * Lazy access to the vendored OpenBible section-counts dataset (AQU-515).
 *
 * The raw file is ~390 KB, the same order as `parsers/ebible/vref.txt`, so it
 * is pulled in through a dynamic `import(… ?raw)` rather than a static one:
 * Vite splits it into its own chunk, and a project that never opens a scripture
 * file never downloads it. Parsing runs once per session and is memoized on the
 * promise, so concurrent callers share one parse.
 */
let indexPromise: Promise<PericopeIndex> | null = null

export function loadPericopeIndex(): Promise<PericopeIndex> {
  indexPromise ??= import("./bible-section-counts.txt?raw")
    .then((module) => indexSections(parseSectionCounts(module.default)))
    .catch(() => {
      // A chunk that fails to load (offline first visit, cache miss on a stale
      // deploy) must cost the translator nothing but the suggestions. Clear the
      // memo so the next open retries instead of caching the failure forever.
      indexPromise = null
      return new Map<string, never[]>() satisfies PericopeIndex
    })
  return indexPromise
}

/** Drop the memo so a test can load the dataset under fresh conditions. */
export function resetPericopeIndexForTests(): void {
  indexPromise = null
}
