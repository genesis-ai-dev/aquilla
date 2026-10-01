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

/**
 * AQU-1493: the one book a FILE holds, or '' when it holds none or several —
 * as a scalar subquery that binds (projectId, fileId).
 *
 * Exists for the lines nobody gave a reference. A line added in the editor
 * (`handleAddCell`) carries no canonical_ref, so `bookKeyExpr` puts it in no
 * book at all: the file's own row counted it, every book and chapter row did
 * not. Six blank added lines left a book reading 100% and "Nothing left" on
 * the board while the file's untranslated count said six (ETEN, 2026-09-29).
 *
 * In a file that holds ONE book there is no doubt where such a line belongs,
 * so `unitBookKeyExpr` counts it there. In a file of several books there is,
 * and nothing here guesses: those lines stay in the file's row only, and the
 * board says so in words rather than in a number nobody can find.
 *
 * Parked cells (`hidden_at`, AQU-1424 — see visibleSourceSql) do not decide
 * it: the projection drops them before counting anything, and the book rows
 * it writes have to be the same set this answer is drawn from, or a file whose
 * only other book is parked would be told it has two.
 */
export function soleBookSql(): string {
  return `(SELECT CASE WHEN COUNT(DISTINCT keyed.book_key) = 1 THEN MIN(keyed.book_key) ELSE '' END
             FROM (SELECT ${bookKeyExpr('sole')} AS book_key
                     FROM cells sole
                    WHERE sole.project_id = ? AND sole.file_id = ? AND sole.side = 'source'
                      AND sole.hidden_at IS NULL) keyed
            WHERE keyed.book_key <> '')`
}

/**
 * AQU-1493: the book a cell COUNTS toward on the plan — its own book key, or,
 * for a line with none, the file's one book (`soleBook`, an expression such as
 * `(SELECT v FROM sole_book)`). The projection's book rows and every reader
 * that must count the same cells use this, never `bookKeyExpr` alone.
 *
 * COALESCE evaluates lazily, so the sole-book lookup is only consulted for
 * the lines that need it.
 */
export function unitBookKeyExpr(alias: string, soleBook: string): string {
  return `COALESCE(NULLIF(${bookKeyExpr(alias)}, ''), ${soleBook})`
}
