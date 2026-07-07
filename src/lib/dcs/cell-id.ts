// Deterministic, content-addressed ids for DCS-imported content (spec §5).
//
// Mirrors the u5() pattern in src/lib/migrate/ids.ts: every id is a UUIDv5
// derived from STABLE inputs (repo + reference/path), never a clock or random
// value. This is the backbone of cross-import lineage — re-importing a Door43
// repo derives the exact same cell ids, so the server's idempotent /import turns
// replays into no-ops and downstream translations stay pinned to their sources.

import { v5 as uuidv5 } from "uuid"

/**
 * Fixed DCS namespace UUID. NEVER CHANGE THIS once any real DCS content has been
 * imported — every DCS cell/event/file id derives from it, and changing it would
 * orphan every existing import and its downstream translations.
 */
export const DCS_NS = "adbd5e28-362b-4a7f-9a3b-d8932bc2c265"

/**
 * Stable cell id for a translatable unit. The seed is repo + reference only
 * (e.g. `unfoldingWord/en_ult|TIT 1:1`) — never a commit sha or import time — so
 * v87 and v89 of a repo produce the SAME id for `TIT 1:1`. Re-segmentation
 * (a verse bridge, a moved article) changes the seed → a new id → the old id
 * vanishes from the parse → the adapter emits a delete (§5), never id-churn.
 */
export const dcsCellId = (seed: string): string => uuidv5(seed, DCS_NS)

/**
 * Deterministic EVENT id for a cell mutation at a specific repo revision.
 * Folds the commit sha into the seed so a re-run of the SAME delta derives the
 * same event id and dedupes via the events-table PK (spec §5). Distinct shas
 * (distinct deltas) get distinct event ids.
 */
export const dcsEventId = (repo: string, sha: string, cellId: string): string =>
  uuidv5(`${repo}|${sha}|${cellId}`, DCS_NS)

/**
 * Deterministic file id for a DCS-imported file (a book / story / note file).
 * `key` is the repo-relative path or book/story key; the `|file|` infix keeps
 * the file-id space disjoint from the cell-id space so they can never collide.
 */
export const dcsFileId = (repo: string, key: string): string =>
  uuidv5(`${repo}|file|${key}`, DCS_NS)
