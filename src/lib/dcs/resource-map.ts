// Resource dispatch (spec §4). ROUTES is an ordered list; routeFor() returns the
// first route whose `matches` predicate accepts the (entry, manifest) pair. Each
// route (under ./routes/) turns raw repo files into DcsFile[] with STABLE,
// content-addressed ids (spec §5) — it reuses the existing format parser, then
// OVERRIDES the parser's fresh uuids with `dcsCellId(seed)` so cross-import
// lineage holds.

import type { DcsCatalogEntry, DcsManifest, ResourceRoute } from "./types"
import { usfmRoute } from "./routes/usfm"
import { obsRoute } from "./routes/obs"
import { tsvNotesRoute } from "./routes/tsv-notes"
import { tsvQuestionsRoute } from "./routes/tsv-questions"

// ── Ordered dispatch list. First `matches` wins. ───────────────────────────
//
// USFM stays first (its predicate is the broadest — any usfm content_format).
// OBS / TSV predicates are disjoint from USFM and from each other, so their
// relative order is not load-bearing.
//
// SWARM-TODO(Slice E tail): markdown Translation Words (`md-dict`) and Translation
// Academy (`md-manual`) routes — split each article by heading/blank-line block,
// id seed `${repo}|${path}|${blockIdx}` (spec §4). These are id-UNSTABLE (no ID
// column; content-hash matching absorbs reflow) and LOWEST priority per §12 — do
// not build until everything above is verified. Tracked in docs/swarm/DCS-TRACES.md.
export const ROUTES: ResourceRoute[] = [usfmRoute, obsRoute, tsvNotesRoute, tsvQuestionsRoute]

/** Return the first route matching (entry, manifest), or null if none. */
export function routeFor(entry: DcsCatalogEntry, manifest: DcsManifest): ResourceRoute | null {
  return ROUTES.find((r) => r.matches(entry, manifest)) ?? null
}
