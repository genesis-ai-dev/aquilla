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
