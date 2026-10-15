// AQU-1969: what an assignment hands out — the "Task" field on both Assign
// surfaces (AssignModal and the Team card's AssignWork panel). Translate is
// the assignment as it has always been and stays the default; Validate gives
// the person only the approving, and their progress then counts their own
// approvals. One component so the two surfaces can never word it differently.

import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useT } from "@/lib/i18n/I18nProvider"
import type { AssignmentKind } from "@/lib/sync/assignments"

export function AssignKindField({
  id,
  value,
  onChange,
  disabled,
}: {
  /** The trigger's id, so the label points at it. */
  id: string
  value: AssignmentKind
  onChange: (kind: AssignmentKind) => void
  disabled?: boolean
}) {
  const t = useT()
  const items: { value: AssignmentKind; label: string }[] = [
    { value: "translate", label: t("dialog.assign.kind.translate") },
    { value: "validate", label: t("dialog.assign.kind.validate") },
  ]
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("dialog.assign.kindLabel")}</FieldLabel>
      <Select
        items={items}
        value={value}
        onValueChange={(v) => onChange(v === "validate" ? "validate" : "translate")}
        disabled={disabled}
      >
        <SelectTrigger id={id} data-testid={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {/* Said only for Validate: Translate is the assignment everyone knows,
          and a sentence under it would explain nothing new. */}
      {value === "validate" && (
        <FieldDescription>{t("dialog.assign.kindValidateDescription")}</FieldDescription>
      )}
    </Field>
  )
}
