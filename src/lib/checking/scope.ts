/** AQU-1249: a checking link snapshots explicitly selected units. New units
 * never silently become public when a file or project later grows. */
export interface CheckingUnit {
  fileId: string
  cellId: string
}
export interface CheckingFile {
  fileId: string
  name: string
  units: Array<{ cellId: string; label: string; section: string }>
}
export type CheckingRole = "viewer" | "commenter" | "reviewer"
export const checkingUnitKey = (unit: CheckingUnit) => JSON.stringify([unit.fileId, unit.cellId])
export function selectionState(units: CheckingUnit[], selected: ReadonlySet<string>) {
  const count = units.filter(unit => selected.has(checkingUnitKey(unit))).length
  return { checked: units.length > 0 && count === units.length, indeterminate: count > 0 && count < units.length }
}
export function toggleUnits(units: CheckingUnit[], selected: ReadonlySet<string>, checked: boolean) {
  const next = new Set(selected)
  for (const unit of units) {
    if (checked) next.add(checkingUnitKey(unit))
    else next.delete(checkingUnitKey(unit))
  }
  return next
}
export function selectedUnits(files: CheckingFile[], selected: ReadonlySet<string>): CheckingUnit[] {
  return files.flatMap(file => file.units.map(unit => ({ fileId: file.fileId, cellId: unit.cellId })))
    .filter(unit => selected.has(checkingUnitKey(unit)))
}
export function sectionForRef(ref: string | null): string {
  const match = ref?.match(/^(.+?\s+\d+):/)
  return match?.[1] ?? "Units"
}

/** Some importers use the cell UUID as canonicalRef. That is an internal
 * identity, not a useful passage label for a community listener. */
export function checkingLabel(ref: string | null, index: number): string {
  return ref?.trim() && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ref.trim())
    ? ref : `Unit ${index + 1}`
}
