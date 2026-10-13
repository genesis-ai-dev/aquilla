// AQU-1605: "which of its translations?" — the lane a chain link consumes.
//
// Shown only for `consumes: 'target'`: a link that consumes the upstream's
// SOURCE has one lane to read and nothing to ask. Both link flows render this
// same field (see useUpstreamLaneChoices) so the question, its failure states
// and its pre-fill rule cannot drift between them.
//
// Pre-filling a single lane is deliberate and is the decision on AQU-1419 ("no
// forced chooser at one lane; lane fields are pre-filled when there is one"):
// the lane is still named on screen, so the choice is visible rather than
// implicit, but a project with one translation does not make the user confirm
// which one it is. The caller owns that pre-fill — this component only reports
// what the user picks.

import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useT } from "@/lib/i18n/I18nProvider"
import type { UpstreamLaneChoice } from "@/lib/sync/link-source-preview"

export interface UpstreamLaneChoiceFieldProps {
  id: string
  /** Null while loading; `[]` for an upstream with no lane this user may use. */
  lanes: UpstreamLaneChoice[] | null
  failed: boolean
  value: string
  onValueChange: (laneId: string) => void
  onRetry: () => void
  /** The create dialog locks its fields while the create is in flight. */
  disabled?: boolean
  /** Rendered under the select — the form's own error for this field. */
  error?: ReactNode
  invalid?: boolean
}

export function UpstreamLaneChoiceField({
  id,
  lanes,
  failed,
  value,
  onValueChange,
  onRetry,
  disabled,
  error,
  invalid,
}: UpstreamLaneChoiceFieldProps) {
  const t = useT()
  if (failed) {
    return (
      <div className="flex items-center gap-2">
        <p className="text-sm text-destructive">
          {t("projectSettings.create.upstreamLaneLoadError")}
        </p>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onRetry}>
          {t("projectSettings.create.upstreamLaneRetry")}
        </Button>
      </div>
    )
  }
  if (lanes === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("projectSettings.create.upstreamLaneLoading")}
      </p>
    )
  }
  if (lanes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("projectSettings.create.upstreamLaneNone")}
      </p>
    )
  }
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{t("projectSettings.create.upstreamLaneLabel")}</FieldLabel>
      {/* `null`, never `undefined`, for "nothing picked": Base UI reads an
          undefined `value` as the uncontrolled mode and then ignores every later
          change, which is how a pre-filled single lane ends up set in the form
          and still showing the placeholder. */}
      {/* `items` maps lane id → label so the trigger reads the lane's NAME
          before the popup has ever been opened. Base UI resolves a selected
          value's label from the mounted items otherwise, and those live in a
          portal that a pre-filled single lane never opens — which showed the raw
          lane id on the trigger. */}
      <Select
        value={value === "" ? null : value}
        items={Object.fromEntries(
          lanes.map((lane) => [
            lane.id,
            lane.label || t("projectSettings.create.upstreamLaneUnnamed"),
          ]),
        )}
        onValueChange={(next) => onValueChange(next ?? "")}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-label={t("projectSettings.create.upstreamLaneLabel")}>
          <SelectValue placeholder={t("projectSettings.create.upstreamLanePlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          {lanes.map((lane) => (
            <SelectItem key={lane.id} value={lane.id}>
              {lane.label || t("projectSettings.create.upstreamLaneUnnamed")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error}
    </Field>
  )
}
