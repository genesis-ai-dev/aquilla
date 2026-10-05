// The human reference a row is known by ("GEN 1:1", "B4"), or undefined when
// the cell has none. Importers also store opaque UUIDs as canonical refs;
// those carry no useful context, so they never count.
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function namedCellRef(cell: {
  context?: string | null
  globalReferences?: readonly string[] | null
}): string | undefined {
  return [cell.context, ...(cell.globalReferences ?? [])]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value) && !OPAQUE_ID.test(value!))
}
