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
 * AQU-1493: the cell types that INTRODUCE what follows them — a section heading
 * or a title — and so count with the referenced line BELOW them rather than the
 * one above. The AQU-1083 structural set (sync-worker's STRUCTURAL_CELL_TYPES),
 * restated here because db/shared imports nothing; a sync-worker test fails if
 * the two ever drift.
 */
export const INTRODUCING_CELL_TYPES = ['heading', 'paratext'] as const

/**
 * Whether a cell introduces what follows. The COALESCE is load-bearing for the
 * reason structural-cells.ts gives: a null type is content, and this is used
 * inside boolean ORs where a NULL would poison the whole flag.
 */
function introducesSql(alias: string): string {
  const list = INTRODUCING_CELL_TYPES.map((t) => `'${t}'`).join(', ')
  return `(COALESCE(${alias}.type, '') IN (${list}))`
}

/**
 * Whether a cell is a SECTION heading — the introducing type that introduces a
 * chapter's verses. The other one, paratext, is a book's title, running header,
 * table of contents or introduction, which introduces the BOOK: at the start
 * of a book it stays on that book's front matter (see `inheritedKeysSql`).
 */
function isSectionHeadingSql(alias: string): string {
  return `(COALESCE(${alias}.type, '') = 'heading')`
}

/**
 * AQU-1493: where a line with no verse reference is COUNTED — one row per such
 * source cell, as a self-contained query to use as a CTE body. `filesSql`
 * yields the (project_id, file_id) rows to look in (see `oneScriptureFileSql`)
 * and carries the caller's binds; nothing else here binds.
 *
 * Sam's rule (2026-10-01), extended for headings by the lead (2026-10-02):
 * - a line nobody gave a reference — one added in the editor — belongs to the
 *   chapter of the line ABOVE it, however many such lines are stacked up in a
 *   row, and a line at the very top of a file to the front matter of the
 *   file's first book;
 * - a heading (or title, `INTRODUCING_CELL_TYPES`) belongs to the chapter of
 *   the referenced line BELOW it — the verse it introduces. Imported Bibles
 *   carry thousands of headings with no reference, and under the line-above
 *   rule "The Seventh Day", printed right before Genesis 2:1, counted in
 *   Genesis 1, every chapter-opening heading in the chapter before it, and a
 *   book's opening heading in the previous book. With no referenced line
 *   below (end of file) a heading falls back to the line above.
 * - a book's title, header, table of contents or introduction (paratext, as
 *   opposed to a section heading) at the START of a book — at the top of the
 *   file, or between the last verse of one book and the first of the next —
 *   belongs to that book's FRONT MATTER, not its chapter 1 (decision,
 *   2026-10-02). The plain USFM importer gives "\mt1 Genesis" no reference,
 *   while the lossless one keys the same line "GEN:mt1:1", already front
 *   matter; the board's answer should not depend on the importer. Paratext in
 *   the middle of a book (\ms, \r) introduces what follows like a heading.
 * Applied together, per RUN (a maximal stretch of lines with no reference):
 * lines before the run's first heading take the line above; that heading and
 * EVERYTHING after it in the run take the line below — except, in a run that
 * starts a book, the paratext before the run's first section heading, which
 * takes the front matter of the book below. So a line added right
 * under "The Seventh Day" counts where the heading counts (Genesis 2), and one
 * added after 1:31, above the heading, stays in Genesis 1 — "the line above"
 * for an added line is the heading when there is one. The editor's own chapter
 * jump (milestone-navigation.ts) agrees: structural cells take the NEXT
 * milestone, other lines the previous one.
 *
 * Projection-time only: nothing is written to the cells, so imports, exports
 * and verse chips that read `canonical_ref` see exactly what they saw before.
 * The answer is stored beside them instead (`cell_plan_keys`, written by the
 * full progress recompute through `planKeysRefreshSql`), and every other
 * reader joins that rather than running this walk.
 * The type test ignores the "count headings" policy on purpose: a heading the
 * project does not count still decides where the lines under it count.
 *
 * "ABOVE" AND "BELOW" ARE THE ANCHOR CHAIN, not `sequence_index`. The editor
 * orders a file by walking `anchor_cell_id` (walkAnchorChain), and a move
 * rewrites only the anchor — `sequence_index` keeps its old value — so a
 * window over it would follow where a line WAS. The chain is walked DOWNWARD,
 * once: from each referenced line (or the head of the file) into the run of
 * unreferenced lines hanging below it, one `idx_cells_file_order` probe per
 * line, and the walk takes ONE more step to the run's terminal — the first
 * referenced line below, which is where it would have stopped anyway — so the
 * line below costs a join of each run to its own end rather than a second walk
 * up. Linear in the number of unreferenced lines however long their runs are.
 *
 * Whatever no walk reaches — a chain whose anchor dangles — and a run at the
 * head of the file with no heading in it go to the FRONT MATTER of the file's
 * first book: the book of the first referenced line from the head. Its section
 * key is that bare book code ("JON"), the key USFM front matter already uses,
 * so the board draws it on the existing "front matter" tile.
 *
 * Columns: section_key (the chapter, or the bare book for front matter);
 * place_ref and a SIGNED depth, so readers can list a line where it sits:
 * depth > 0 is that many lines AFTER place_ref (a line counted with the line
 * above; place_ref '' = the top of the file), depth < 0 that many lines BEFORE
 * it (a heading and what follows it, counted with the line below). Sorting by
 * (place_ref, depth) with a referenced line at depth 0 puts a heading right
 * before the verse it introduces, even in a file whose books are out of order.
 */
export function inheritedKeysSql(filesSql: string): string {
  const own = ownChapterExpr
  return `WITH RECURSIVE ik_files AS MATERIALIZED (
             ${filesSql}
           ), ik_unref AS MATERIALIZED (
             SELECT u.project_id, u.file_id, u.cell_id, u.anchor_cell_id,
                    ${introducesSql('u')} AS introduces,
                    ${isSectionHeadingSql('u')} AS section_heading
               FROM ik_files f
               JOIN cells u ON u.project_id = f.project_id AND u.file_id = f.file_id
                           AND u.side = 'source'
              WHERE ${own('u')} = ''
           ), ik_run (project_id, file_id, cell_id, run_id, above_key, above_ref,
                      depth, own_key, own_ref, after_intro, after_heading) AS (
             -- A run starts at a line with no reference hanging below a
             -- referenced line (above_key = that line's chapter), or at the
             -- head of the file (above_key NULL). Its first line names it.
             SELECT u.project_id, u.file_id, u.cell_id, u.cell_id,
                    CASE WHEN u.anchor_cell_id IS NULL THEN NULL::text ELSE ${own('a')} END,
                    COALESCE(a.canonical_ref, ''::text),
                    1, ''::text, NULL::text, u.introduces, u.section_heading
               FROM ik_unref u
               LEFT JOIN cells a ON a.project_id = u.project_id AND a.file_id = u.file_id
                                AND a.side = 'source' AND a.cell_id = u.anchor_cell_id
              WHERE u.anchor_cell_id IS NULL OR ${own('a')} <> ''
             UNION ALL
             -- …and runs down the chain to the first referenced line below it,
             -- which is included (own_key <> '') and goes no further. A cell has
             -- one anchor, so this is a tree walk from a root outside the run:
             -- it cannot cycle. after_intro: a heading or paratext at or above
             -- this line in the run; after_heading: a section heading.
             SELECT n.project_id, n.file_id, n.cell_id, r.run_id, r.above_key, r.above_ref,
                    r.depth + 1, ${own('n')}, n.canonical_ref,
                    r.after_intro OR ${introducesSql('n')},
                    r.after_heading OR ${isSectionHeadingSql('n')}
               FROM ik_run r
               JOIN cells n ON n.project_id = r.project_id AND n.file_id = r.file_id
                           AND n.side = 'source' AND n.anchor_cell_id = r.cell_id
              WHERE r.own_key = ''
           ), ik_end AS (
             -- Each run's line below. Two lines on one anchor branch the chain;
             -- the nearest terminal wins, deterministically.
             SELECT DISTINCT ON (project_id, file_id, run_id)
                    project_id, file_id, run_id, above_key IS NULL AS at_top,
                    own_key AS below_key, own_ref AS below_ref, depth AS below_depth
               FROM ik_run
              WHERE own_key <> ''
              ORDER BY project_id, file_id, run_id, depth, cell_id
           ), ik_front AS (
             -- The file's first book: the first referenced line from the head,
             -- which is the head itself or the end of the run at the top.
             SELECT DISTINCT ON (project_id, file_id)
                    project_id, file_id, SPLIT_PART(first_key, ' ', 1) AS book_key
               FROM (
                 SELECT e.project_id, e.file_id, e.below_key AS first_key, e.below_depth AS depth
                   FROM ik_end e
                  WHERE e.at_top
                 UNION ALL
                 SELECT h.project_id, h.file_id, ${own('h')}, 0
                   FROM ik_files f
                   JOIN cells h ON h.project_id = f.project_id AND h.file_id = f.file_id
                               AND h.side = 'source' AND h.anchor_cell_id IS NULL
                  WHERE ${own('h')} <> ''
               ) firsts
              ORDER BY project_id, file_id, depth, first_key
           ), ik_placed AS (
             -- to_front: paratext opening a book (the run is at the top of the
             -- file, or the book changes across it) and above its first
             -- section heading — the book below's front matter.
             SELECT r.project_id, r.file_id, r.cell_id,
                    (r.after_intro AND e.below_key IS NOT NULL) AS to_below,
                    (r.after_intro AND NOT r.after_heading AND e.below_key IS NOT NULL
                      AND (r.above_key IS NULL
                           OR SPLIT_PART(r.above_key, ' ', 1) <> SPLIT_PART(e.below_key, ' ', 1)))
                      AS to_front,
                    r.above_key, r.above_ref, r.depth,
                    e.below_key, e.below_ref, e.below_depth, fr.book_key
               FROM ik_run r
               LEFT JOIN ik_end e
                 ON e.project_id = r.project_id AND e.file_id = r.file_id AND e.run_id = r.run_id
               LEFT JOIN ik_front fr ON fr.project_id = r.project_id AND fr.file_id = r.file_id
              WHERE r.own_key = ''
           )
           SELECT p.project_id, p.file_id, p.cell_id,
                  CASE WHEN p.to_front THEN SPLIT_PART(p.below_key, ' ', 1)
                       WHEN p.to_below THEN p.below_key
                       ELSE COALESCE(p.above_key, p.book_key) END AS section_key,
                  CASE WHEN p.to_below THEN p.below_ref
                       WHEN p.above_key IS NOT NULL THEN p.above_ref
                       ELSE ''::text END AS place_ref,
                  CASE WHEN p.to_below THEN p.depth - p.below_depth ELSE p.depth END AS depth
             FROM ik_placed p
            WHERE p.to_below OR p.above_key IS NOT NULL OR p.book_key IS NOT NULL
           UNION ALL
           -- A dangling chain: no run reaches it.
           SELECT u.project_id, u.file_id, u.cell_id, fr.book_key, ''::text, 0
             FROM ik_unref u
             JOIN ik_front fr ON fr.project_id = u.project_id AND fr.file_id = u.file_id
            WHERE NOT EXISTS (
              SELECT 1 FROM ik_run r
               WHERE r.project_id = u.project_id AND r.file_id = u.file_id AND r.cell_id = u.cell_id
            )`
}

/**
 * AQU-1493: where `inheritedKeysSql` placed each line with no reference, as
 * last projected — one row per such source cell of a Scripture file, with the
 * walk's own columns (section_key, place_ref, depth). Migration 0130.
 *
 * STORED BECAUSE THE WALK IS NOT FREE AND ITS ANSWER RARELY MOVES. On a
 * whole-Bible Hello AO import (34k cells, 3,206 headings with no reference)
 * the walk takes 65-80 ms. Run inline, every translation save on the file paid
 * it (the incremental recompute went from ~47 ms to ~135 ms, awaited before
 * the response), a full recompute paid it twice, and so did every chapter card,
 * every "Go to first ..." click, every board load's assignee chips and every
 * assignment.create inside its write transaction. Yet where a line counts
 * changes only when the file's lines move, gain or lose a reference, or change
 * type — and every path that does any of that (source.cell.* events, imports,
 * link syncs, merges, migrations, rebuilds) already runs the full recompute.
 * So the full recompute is the ONE writer (`planKeysRefreshSql`, its first
 * statement) and everything else reads these rows.
 *
 * A row the walk no longer produces is deleted by that same statement; a cell
 * removed some other way leaves an orphan that matches no live cell. Readers
 * prefer a cell's own reference over its row (`unitSectionKeyExpr`), so a
 * stale row can never move a referenced line.
 */
export const PLAN_KEYS_TABLE = 'cell_plan_keys'

/**
 * AQU-1493: rewrite one file's `cell_plan_keys` rows from the walk. Binds
 * (projectId, fileId) for the walk, then (projectId, fileId) for the delete.
 * Writes only the rows that changed, so a recompute that moved nothing writes
 * nothing. A file that is not Scripture walks nothing and is left with no rows.
 */
export function planKeysRefreshSql(): string {
  return `WITH walked AS MATERIALIZED (
             ${inheritedKeysSql(oneScriptureFileSql())}
           ), gone AS (
             DELETE FROM ${PLAN_KEYS_TABLE} k
              WHERE k.project_id = ? AND k.file_id = ?
                AND NOT EXISTS (SELECT 1 FROM walked w WHERE w.cell_id = k.cell_id)
           )
           INSERT INTO ${PLAN_KEYS_TABLE} (project_id, file_id, cell_id, section_key, place_ref, depth)
           SELECT project_id, file_id, cell_id, section_key, place_ref, depth FROM walked
           ON CONFLICT (project_id, file_id, cell_id) DO UPDATE SET
             section_key = EXCLUDED.section_key,
             place_ref = EXCLUDED.place_ref,
             depth = EXCLUDED.depth
           WHERE (${PLAN_KEYS_TABLE}.section_key, ${PLAN_KEYS_TABLE}.place_ref, ${PLAN_KEYS_TABLE}.depth)
                 IS DISTINCT FROM (EXCLUDED.section_key, EXCLUDED.place_ref, EXCLUDED.depth)`
}

/**
 * AQU-1493: LEFT JOIN a source cell `cellAlias` onto its stored placement, as
 * `alias` (section_key, place_ref, depth; all NULL for a referenced line).
 */
export function planKeysJoinSql(cellAlias: string, alias = 'ik'): string {
  return `LEFT JOIN ${PLAN_KEYS_TABLE} ${alias}
             ON ${alias}.project_id = ${cellAlias}.project_id AND ${alias}.file_id = ${cellAlias}.file_id
            AND ${alias}.cell_id = ${cellAlias}.cell_id`
}

/**
 * AQU-1493: the section a source cell counts toward on the plan — its own
 * key, or for a line with no reference the one `inheritedKeysSql` gave it.
 * `inherited` is the caller's alias for that placement (`planKeysJoinSql`).
 * A cell's own reference wins over any row, so an orphaned row is harmless.
 */
export function unitSectionKeyExpr(alias: string, inherited: string): string {
  return `COALESCE(NULLIF(${ownChapterExpr(alias)}, ''), ${inherited}.section_key, ${sectionKeyExpr(alias)})`
}

/** The book a source cell counts toward on the plan: see `unitSectionKeyExpr`. */
export function unitBookKeyExpr(alias: string, inherited: string): string {
  return `COALESCE(NULLIF(${bookKeyExpr(alias)}, ''), SPLIT_PART(${inherited}.section_key, ' ', 1), ${bookKeyExpr(alias)})`
}
