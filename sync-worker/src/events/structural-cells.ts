// Which cells are STRUCTURE rather than content. (AQU-1083)
//
// Book titles, chapter markers and section heads: the cells a USFM import types
// `heading` or `paratext`. They are translatable — some teams do translate them
// — but whether they count toward a project's PROGRESS is team policy, because
// counting them means a book whose every verse is done still reads below 100%.
//
// One definition, quoted here once, because the alternative is what the client
// already had: the same set written out twice with slightly different rules and
// no answer to "is this cell structural". The client's copy of this lives in
// src/lib/cells/structural.ts and must agree with it.
//
// NOT null-safe by accident: `type` is null for every media and cue import, and
// null must read as CONTENT. `type IN (...)` yields NULL for a null type, which
// FILTER and WHERE both treat as false — the behaviour we want, but only
// because the test says so rather than because SQL is obvious here.

export const STRUCTURAL_CELL_TYPES = ['heading', 'paratext'] as const

/**
 * `<alias>.type IN ('heading', 'paratext')` — the SOURCE row's type.
 *
 * Always give it the source alias. Target rows carry no type of their own, so a
 * predicate pointed at a target finds nothing and every structural count comes
 * back zero.
 */
export function structuralPredicateSql(alias: string): string {
  const list = STRUCTURAL_CELL_TYPES.map((t) => `'${t}'`).join(', ')
  return `${alias}.type IN (${list})`
}

/**
 * The effective policy for one project: its own value, else its org's, else
 * "count them".
 *
 * Reads the STORED GENERATED columns rather than the settings blobs, which run
 * to several megabytes each. That is not a micro-optimisation — reading the
 * blob inline on a fan-out path is what timed the org dashboard out at fifteen
 * seconds, and migration 0063 exists because of it.
 *
 * Absent reads as true at both levels, so a project that has never heard of
 * this setting behaves exactly as it does today.
 */
export async function readCountStructuralCells(
  db: { prepare(sql: string): { bind(...a: unknown[]): { first<T>(): Promise<T | null> } } },
  projectId: string,
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT COALESCE(ps.count_structural, os.count_structural) AS effective
           FROM projects p
           LEFT JOIN project_settings ps ON ps.project_id = p.id
           LEFT JOIN org_settings os ON os.org_id = p.org_id
          WHERE p.id = ?`,
      )
      .bind(projectId)
      .first<{ effective: string | null }>()
    return row?.effective === 'false' ? false : true
  } catch {
    return true
  }
}
