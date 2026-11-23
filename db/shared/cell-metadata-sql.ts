// AQU-1780: the metadata a bulk cells read hands out.
//
// Legacy IDML migrations (src/lib/migrate/map.ts, AQU-707) copied the FILE's
// migration diagnostics into every source cell's `metadata.idmlMigration`:
// the same ~200 KB list on each of a file's rows. Postgres stores it
// compressed, so the table never looked heavy, but a read decompresses it
// once per row. One 1,389-cell Biblica file came to ~290 MB of metadata, and
// its second paired page (2,000 rows) needed ~340 MB in a Worker isolate that
// is allowed 128 MB — Cloudflare killed it (1102 exceededMemory) on every try.
//
// Nothing reads the list: `idmlMigration` has no reader outside the migration
// code. The per-cell `version` / `readiness` stay; only `diagnostics` goes.
// Both workers reach this module, so the expression is written once.

/**
 * SQL expression for a cell's metadata without `idmlMigration.diagnostics`.
 * `alias` is the cells table or alias in scope (`cells`, `s`, …); omit it for
 * an unqualified `metadata`. Does not name the result — callers add `AS`.
 *
 * Guarded on `jsonb_typeof`: `#-` throws on a scalar or array value
 * ("cannot delete path in scalar"), and production holds source rows whose
 * metadata is a double-encoded JSON string. `->` yields NULL on those instead
 * of throwing, so every non-object shape passes through unchanged.
 */
export function cellMetadataWireSql(alias?: string): string {
  const col = alias ? `${alias}.metadata` : "metadata"
  return `CASE WHEN jsonb_typeof(${col}->'idmlMigration') = 'object' THEN ${col} #- '{idmlMigration,diagnostics}' ELSE ${col} END`
}

/**
 * SQL expression for the value a shallow merge into a cell's metadata builds
 * on: `${cellMetadataMergeBaseSql()} || patch`.
 *
 * `jsonb || jsonb` merges keys only when BOTH sides are objects. With a scalar
 * on the left it builds an array instead: `'"…"' || '{}'` is `["…", {}]`. And a
 * source link's mirror stores a cell's envelope as exactly that scalar — a
 * double-encoded JSON string (`source.cell.mirror` binds the stringified
 * envelope straight to the JSONB column). Reads unwrap it, so the row looks
 * like any other until something merges into it; then the envelope is the
 * first element of an array no reader takes for metadata, and the cell has
 * lost its IDML locator, its protected runs and its section title at once.
 *
 * So a string that holds a JSON object is merged as that object. Every other
 * stored shape gives what `COALESCE(metadata, '{}') || patch` always gave:
 * NULL starts from `{}`, an object is itself, and anything unrecognised is
 * passed through untouched rather than guessed at.
 *
 * The CASEs are nested, not ANDed: Postgres promises not to evaluate a CASE
 * branch it does not take, and makes no such promise about the operands of
 * AND. The cast therefore only ever sees text `pg_input_is_valid` accepted.
 */
export function cellMetadataMergeBaseSql(alias?: string): string {
  const col = alias ? `${alias}.metadata` : "metadata"
  const text = `(${col} #>> '{}')`
  return `CASE
    WHEN ${col} IS NULL THEN '{}'::jsonb
    WHEN jsonb_typeof(${col}) = 'string' THEN
      CASE WHEN pg_input_is_valid(${text}, 'jsonb') THEN
        CASE WHEN jsonb_typeof(${text}::jsonb) = 'object' THEN ${text}::jsonb ELSE ${col} END
      ELSE ${col} END
    ELSE ${col}
  END`
}
