/**
 * AQU-1069 — short, *distinguishing* cell-id labels.
 *
 * Several surfaces label a cell by a truncated cell id when it has no
 * canonical ref / context to show. They used to truncate from the FRONT
 * (`id.slice(0, 8)`), which is silently wrong for our ids: cell ids minted by
 * the import pipeline are UUIDv7 (`src/lib/import.ts` → `uuidv7()`,
 * `src/lib/parsers/parse-text-formats.ts`, …), and a UUIDv7's leading hex
 * digits are the millisecond timestamp. The first 8 characters only change
 * once every 2^16 ms (~65 s), so EVERY cell of a single import renders the
 * same "id" — which reads as duplicate cell ids in the editor / agent view
 * even though the underlying ids are unique (the `cells` projection is keyed
 * `(project_id, file_id, cell_id, side, target_lang)`, so genuine duplicate
 * rows cannot exist).
 *
 * So truncate from the BACK instead: the trailing digits are the random
 * (`rand_b`) half in UUIDv7 and random in UUIDv4, so the short form varies
 * per cell for both.
 */

/** Characters of the id to keep. 8 hex digits ≈ 4e9 values — plenty to tell
 *  neighbouring rows apart, and it still fits the narrow mono ref column. */
export const SHORT_CELL_ID_LENGTH = 8

/**
 * A short label for `id` that differs between cells minted in the same import.
 *
 * Dashes are stripped first so the kept window is always 8 significant hex
 * digits rather than however many a dash happened to eat. Ids shorter than the
 * window are returned unchanged.
 */
export function shortCellId(id: string): string {
  const compact = id.replace(/-/g, "")
  return compact.length <= SHORT_CELL_ID_LENGTH ? compact : compact.slice(-SHORT_CELL_ID_LENGTH)
}
