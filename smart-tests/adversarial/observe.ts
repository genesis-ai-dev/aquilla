/** What `newlySeen` reads from one editable element on the page. */
export interface FieldReading {
  value: string
  label: string
  placeholder: string
  type: string
  role: string
}

/**
 * A field that only filters what the page shows. Typing the intended value
 * into one is not an attempt at the goal: on PR #2092 an agent typed a
 * project's new name into "Search projects…", found nothing and stopped, and
 * the run scored that as a product failure. The projects table's search box
 * is a plain `<input>`, so its label is the only signal it carries.
 */
export function isSearchField(field: FieldReading): boolean {
  return field.type === "search" || field.role === "searchbox"
    || /^search\b/i.test(field.label.trim()) || /^search\b/i.test(field.placeholder.trim())
}

/** True when a field that is not a search box holds one of the wanted values. */
export function showsIntendedValue(fields: FieldReading[], wanted: string[]): boolean {
  return fields.some((field) => !isSearchField(field) && wanted.includes(field.value.trim()))
}
