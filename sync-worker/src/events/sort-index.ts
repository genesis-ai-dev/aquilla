/**
 * AQU-1569: the hand-placed sidebar position of a file, kept in
 * `files.meta.sortIndex`.
 *
 * The value is deliberately fractional — placing a file between two neighbours
 * is the midpoint of their indices, so two leads moving two different files
 * write two different rows and neither loses the other's move. That makes
 * "is this a real, orderable number" the only validation there is: there is no
 * range to police (a move to the top of a group is legitimately negative) and
 * no granularity to enforce.
 */

/**
 * Accept a sort index for persistence. Anything that is not a finite number —
 * a string, a NaN, an Infinity, a null — is rejected, because a file carrying
 * one could not be ordered against its siblings by any comparator. Callers
 * read `undefined` as "this file has no hand-placed position", which is the
 * state every file is in until someone reorders its group.
 */
export function usableSortIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
