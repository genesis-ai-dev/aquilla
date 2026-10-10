import { useT } from "@/lib/i18n/I18nProvider"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field"
import { checkingUnitKey, selectionState, toggleUnits, type CheckingFile, type CheckingUnit } from "@/lib/checking/scope"

export function CheckingScopePicker({ files, selected, onChange }: {
  files: CheckingFile[]
  selected: ReadonlySet<string>
  onChange: (selected: Set<string>) => void
}) {
  const t = useT()
  const all = files.flatMap(file => file.units.map(unit => ({ fileId: file.fileId, cellId: unit.cellId })))
  function pick(label: string, units: CheckingUnit[], id: string) {
    const state = selectionState(units, selected)
    return <Field orientation="horizontal">
      <Checkbox id={id} {...state} disabled={!units.length}
        onCheckedChange={checked => onChange(toggleUnits(units, selected, checked))} />
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
    </Field>
  }
  return <FieldSet>
    <FieldLegend>{t("projectSettings.checking.scopeTitle")}</FieldLegend>
    {pick(t("projectSettings.checking.wholeProject"), all, "checking-project")}
    <div className="flex max-h-72 flex-col gap-3 overflow-auto rounded-md border p-3">
      {files.map((file, fileIndex) => <div key={file.fileId} className="flex flex-col gap-2">
        {pick(file.name, file.units.map(unit => ({ fileId: file.fileId, cellId: unit.cellId })), `checking-file-${fileIndex}`)}
        <div className="flex flex-col gap-2 pl-6">
          {[...new Set(file.units.map(unit => unit.section))].map((section, sectionIndex) => {
            const units = file.units.filter(unit => unit.section === section)
            return <details key={section}>
              <summary className="cursor-pointer py-1 text-sm">{section}</summary>
              <div className="flex flex-col gap-2 py-2 pl-4">
                {pick(t("projectSettings.checking.allSection", { section }), units.map(unit => ({ fileId: file.fileId, cellId: unit.cellId })), `checking-section-${fileIndex}-${sectionIndex}`)}
                {units.map((unit, unitIndex) => <div key={checkingUnitKey({ fileId: file.fileId, cellId: unit.cellId })}>
                  {pick(unit.label, [{ fileId: file.fileId, cellId: unit.cellId }], `checking-unit-${fileIndex}-${sectionIndex}-${unitIndex}`)}
                </div>)}
              </div>
            </details>
          })}
        </div>
      </div>)}
      {!files.length && <p className="text-sm text-muted-foreground">{t("projectSettings.checking.emptyProject")}</p>}
    </div>
  </FieldSet>
}
