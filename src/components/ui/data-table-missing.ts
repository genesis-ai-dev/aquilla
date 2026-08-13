/**
 * Optional DataTable cell values that render as "—" / empty / Unassigned.
 *
 * TanStack only treats `undefined` as missing for `sortUndefined`, and the
 * `"last"` sentinel is direction-immune (unlike a custom sortingFn that puts
 * nulls last on asc — desc inverts that and floats dashes to the top).
 */
export const SORT_MISSING_LAST = "last" as const

/** Coerce null/blank values to `undefined` so `sortUndefined: "last"` applies. */
export function missingLast<T extends string | number>(
  value: T | null | undefined,
): T | undefined {
  if (value == null) return undefined
  if (typeof value === "string" && value.trim() === "") return undefined
  return value
}
