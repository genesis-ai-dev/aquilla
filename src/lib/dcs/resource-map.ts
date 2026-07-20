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

// ── Entry-level support pre-check (catalog UX, AQU-615) ─────────────────────
//
// The catalog browser needs to grey out dead-end rows BEFORE the user commits
// to an import, but routeFor() needs a manifest — only fetched mid-import. So
// this mirrors the ENTRY-side signals of the route matchers only, and stays
// conservative: only subjects we KNOW have no route are flagged unsupported;
// anything ambiguous stays selectable and falls through to routeFor()'s real
// manifest-aware dispatch.

/** Subject fragments the routes match on the entry side. Mirror of
 *  routes/obs.ts isObs + routes/tsv-notes.ts NOTES_SUBJECTS +
 *  routes/tsv-questions.ts QUESTIONS_SUBJECTS — keep in sync (those lists are
 *  module-private, and this file must not force exports on them). */
const SUPPORTED_SUBJECT_FRAGMENTS = [
  "open bible stories",
  "translation notes",
  "study notes",
  "translation questions",
  "study questions",
]

/** Subjects with NO v1 route (the SWARM-TODO tail above): Translation Words
 *  (Links), Translation Academy, and the original-language grammars. Checked
 *  AFTER the supported fragments so e.g. "TSV OBS Translation Notes" can never
 *  land here. NOTE "translation words" also covers "Translation Words Links". */
const UNSUPPORTED_SUBJECT_FRAGMENTS = [
  "translation words",
  "translation academy",
  "grammar",
]

/** True when a catalog entry looks importable from its catalog row alone —
 *  no manifest required. Unknown-but-maybe counts as supported (the import
 *  path's routeFor() stays the authoritative gate). */
export function isSupportedCatalogEntry(entry: DcsCatalogEntry): boolean {
  const format = entry.contentFormat.toLowerCase()
  if (format === "usfm") return true // usfmRoute's entry-side signal
  const subject = entry.subject.toLowerCase()
  if (SUPPORTED_SUBJECT_FRAGMENTS.some((s) => subject.includes(s))) return true
  if (UNSUPPORTED_SUBJECT_FRAGMENTS.some((s) => subject.includes(s))) return false
  if (format.includes("rst")) return false // x-rst grammars/manuals
  if (format.includes("markdown")) return false // generic markdown help (tw/ta style)
  // Blank/odd format with an unrecognized subject: stay optimistic.
  return true
}
