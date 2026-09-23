// AQU-805/AQU-1093/AQU-1278: how a CELL maps to a section and to a book, as
// SQL both workers can run.
//
// Lives in db/shared/ for the same reason db/shared/plan-units.ts does, one
// level down: two workers now need the identical definition and must never
// drift. sync-worker builds file_section_progress's 'section' and 'book' rows
// from these expressions — which is where the plan board's own totals and bars
// come from — and auth-worker's per-unit assignment read (AQU-1278) has to
// select the SAME cells to count a person's share of a unit. A forked copy of
// the CASE below would put "Anna: 40 of 50" next to a bar drawn over a
// different 50 on the same panel, and nothing on screen would say why.
//
// These are string-building helpers, not statements: they take a table alias
// and compose into a bigger query with the caller's own binds. That is why
// this module takes no db handle and imports nothing.

/**
 * AQU-805: bucket size for time-based (media/timeline) sections — 5 minutes,
 * mirroring the in-app jump navigation's TIMELINE_MILESTONE_MS so the
 * project-overview file breakdown groups media progress the same way.
 */
export const TIMELINE_SECTION_MS = 5 * 60 * 1000

/**
 * AQU-805: the section grouping key for a source cell, as a SQL expression.
 *
 * Canonical (Scripture) files key by "<BOOK> <CHAPTER>" — the canonical_ref
 * before the verse colon — exactly as before. Media / timeline files carry no
 * canonical_ref but do carry start_ms; they key into ~5-minute time buckets
 * ("t:<zero-padded bucket-start ms>") so a single-episode media file shows a
 * per-section breakdown instead of only a flat cell count. The bucket-start ms
 * is zero-padded to a fixed width so the key sorts lexically in time order and
 * the read route's string sort needs no time-awareness. Cells with neither a
 * canonical ref nor a start_ms produce '' and are filtered out (untimed).
 */
export function sectionKeyExpr(alias: string): string {
  const canonical = `TRIM(SPLIT_PART(COALESCE(${alias}.canonical_ref, ''), ':', 1))`
  return `CASE
    WHEN ${canonical} <> '' THEN ${canonical}
    WHEN ${alias}.start_ms IS NOT NULL
      THEN 't:' || LPAD(((${alias}.start_ms / ${TIMELINE_SECTION_MS}) * ${TIMELINE_SECTION_MS})::text, 12, '0')
    ELSE ''
  END`
}

/**
 * AQU-1093: the BOOK grouping key for a source cell, as a SQL expression.
 *
 * A section key is "<BOOK> <CHAPTER>"; the book is its first token. Media
 * files key by time bucket ("t:<ms>") and have no book, and a cell with
 * neither yields '' — both are excluded from book rows.
 *
 * A book-only canonical_ref (a one-chapter book referenced as "TIT") produces
 * section_key 'TIT' AND book_key 'TIT'. Those are different rows with the same
 * key, which is why every grouping that uses this carries `scope` alongside
 * the key.
 */
export function bookKeyExpr(alias: string): string {
  const section = sectionKeyExpr(alias)
  return `CASE
    WHEN ${section} <> '' AND ${section} NOT LIKE 't:%'
      THEN SPLIT_PART(${section}, ' ', 1)
    ELSE ''
  END`
}
