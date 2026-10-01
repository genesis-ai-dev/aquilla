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
 * A cell's chapter key from its OWN reference: "JON 2" from "JON 2:5", "JON"
 * from front matter's "JON:mt1:1", '' for a line with no reference at all.
 * The canonical half of `sectionKeyExpr`, without its time-bucket fallback.
 */
function ownChapterExpr(alias: string): string {
  return `TRIM(SPLIT_PART(COALESCE(${alias}.canonical_ref, ''), ':', 1))`
}

/**
 * AQU-1493: one file, as the row `inheritedKeysSql` wants, when it is
 * Scripture — any source cell with a verse-shaped reference, the same test as
 * the projection's own `has_books` gate. Binds (projectId, fileId).
 *
 * Gated because the walk below only makes sense where chapters exist. A media
 * file has no reference anywhere, and walking its whole chain from the top
 * looking for one would be a probe per line for nothing.
 */
export function oneScriptureFileSql(): string {
  return `SELECT v.project_id, v.file_id
            FROM (VALUES (?::text, ?::text)) AS v(project_id, file_id)
           WHERE EXISTS (
             SELECT 1 FROM cells b
              WHERE b.project_id = v.project_id AND b.file_id = v.file_id AND b.side = 'source'
                AND COALESCE(b.canonical_ref, '') ~ '^\\S+ \\d+:\\d+'
           )`
}

/**
 * AQU-1493: where a line with no verse reference is COUNTED — one row per such
 * source cell, as a self-contained query to use as a CTE body. `filesSql`
 * yields the (project_id, file_id) rows to look in (see `oneScriptureFileSql`)
 * and carries the caller's binds; nothing else here binds.
 *
 * Sam's rule (2026-10-01): a line nobody gave a reference — one added in the
 * editor — belongs to the chapter of the line above it, however many such
 * lines are stacked up in a row, and a line at the very top of a file belongs
 * to the front matter of the file's first book. Projection-time only: nothing
 * is written to the cells, so imports, exports and verse chips that read
 * `canonical_ref` see exactly what they saw before.
 *
 * "THE LINE ABOVE" IS THE ANCHOR CHAIN, not `sequence_index`. The editor orders
 * a file by walking `anchor_cell_id` (walkAnchorChain), and a move rewrites
 * only the anchor — `sequence_index` keeps its old value — so a window over it
 * would follow where a line WAS. The chain is walked DOWNWARD: from each
 * referenced line into the run of unreferenced lines hanging below it, one
 * `idx_cells_file_order` probe per line. That is linear in the number of
 * unreferenced lines however long their runs are; walking UP from each line
 * instead would cost the square of a run's length.
 *
 * Whatever the walk does not reach — a run at the head of the file, or a chain
 * whose anchor dangles — goes to the FRONT MATTER of the file's first book:
 * the book of the first referenced line found walking down from the head. Its
 * section key is that bare book code ("JON"), the key USFM front matter
 * already uses, so the board draws it on the existing "front matter" tile.
 *
 * Columns: section_key (the chapter, or the bare book for front matter);
 * after_ref (the reference of the line it follows, '' at the top) and depth
 * (its place in the run), so readers can list it where it sits in the file.
 */
export function inheritedKeysSql(filesSql: string): string {
  const own = ownChapterExpr
  return `WITH RECURSIVE ik_files AS MATERIALIZED (
             ${filesSql}
           ), ik_unref AS MATERIALIZED (
             SELECT u.project_id, u.file_id, u.cell_id, u.anchor_cell_id
               FROM ik_files f
               JOIN cells u ON u.project_id = f.project_id AND u.file_id = f.file_id
                           AND u.side = 'source'
              WHERE ${own('u')} = ''
           ), ik_below (project_id, file_id, cell_id, section_key, after_ref, depth) AS (
             -- A line right below a referenced one takes that line's chapter…
             SELECT u.project_id, u.file_id, u.cell_id, ${own('a')}, a.canonical_ref, 1
               FROM ik_unref u
               JOIN cells a ON a.project_id = u.project_id AND a.file_id = u.file_id
                           AND a.side = 'source' AND a.cell_id = u.anchor_cell_id
              WHERE ${own('a')} <> ''
             UNION
             -- …and hands it down the run below it. A cell has one anchor, so
             -- this is a tree walk from a root outside the run: it cannot cycle.
             SELECT n.project_id, n.file_id, n.cell_id, b.section_key, b.after_ref, b.depth + 1
               FROM ik_below b
               JOIN cells n ON n.project_id = b.project_id AND n.file_id = b.file_id
                           AND n.side = 'source' AND n.anchor_cell_id = b.cell_id
              WHERE ${own('n')} = ''
           ), ik_top (project_id, file_id, cell_id, own_key, depth) AS (
             -- From the head of the file down to its first referenced line.
             SELECT h.project_id, h.file_id, h.cell_id, ${own('h')}, 1
               FROM ik_files f
               JOIN cells h ON h.project_id = f.project_id AND h.file_id = f.file_id
                           AND h.side = 'source' AND h.anchor_cell_id IS NULL
             UNION
             SELECT n.project_id, n.file_id, n.cell_id, ${own('n')}, t.depth + 1
               FROM ik_top t
               JOIN cells n ON n.project_id = t.project_id AND n.file_id = t.file_id
                           AND n.side = 'source' AND n.anchor_cell_id = t.cell_id
              WHERE t.own_key = ''
           ), ik_front AS (
             SELECT DISTINCT ON (project_id, file_id)
                    project_id, file_id, SPLIT_PART(own_key, ' ', 1) AS book_key
               FROM ik_top
              WHERE own_key <> ''
              ORDER BY project_id, file_id, depth
           )
           SELECT b.project_id, b.file_id, b.cell_id, b.section_key, b.after_ref, b.depth
             FROM ik_below b
           UNION ALL
           SELECT u.project_id, u.file_id, u.cell_id, fr.book_key, ''::text, COALESCE(t.depth, 0)
             FROM ik_unref u
             JOIN ik_front fr ON fr.project_id = u.project_id AND fr.file_id = u.file_id
             LEFT JOIN ik_top t
               ON t.project_id = u.project_id AND t.file_id = u.file_id AND t.cell_id = u.cell_id
            WHERE NOT EXISTS (
              SELECT 1 FROM ik_below b
               WHERE b.project_id = u.project_id AND b.file_id = u.file_id AND b.cell_id = u.cell_id
            )`
}

/**
 * AQU-1493: the section a source cell counts toward on the plan — its own key,
 * or for a line with no reference the one `inheritedKeysSql` gave it.
 * `inherited` is the caller's alias for a LEFT JOIN onto that CTE.
 */
export function unitSectionKeyExpr(alias: string, inherited: string): string {
  return `COALESCE(${inherited}.section_key, ${sectionKeyExpr(alias)})`
}

/** The book a source cell counts toward on the plan: see `unitSectionKeyExpr`. */
export function unitBookKeyExpr(alias: string, inherited: string): string {
  return `COALESCE(SPLIT_PART(${inherited}.section_key, ' ', 1), ${bookKeyExpr(alias)})`
}
