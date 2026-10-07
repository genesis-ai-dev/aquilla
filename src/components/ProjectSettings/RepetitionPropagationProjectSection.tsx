// AQU-1391: this project's answer to "does validating a cell fill in its
// repetitions", with a third option that defers to the organization.
//
// Three states, and the third one is an ABSENCE — "Organization default" is
// the key not being stored at all. Same shape and same reasoning as
// StructuralCellsProjectSection beside it, including why it patches the shared
// settings blob directly rather than going through the page's draft/baseline
// machinery (that machinery seeds from the project record, which is fetched
// without the settings overlay, so a tri-state seeded from it would read
// "inherit" for a project that had explicitly chosen something).

import { useState } from "react"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ReactNode } from "react"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

type Choice = "inherit" | "on" | "off"

interface Props {
  /** The project's stored answer. Undefined = inherit the organization. */
  value: boolean | undefined
  /** The org's effective default, so the inherit option can say what it means. */
  orgDefault: boolean
  disabled?: boolean
  disabledTooltip?: ReactNode
  /** Patches the shared settings blob. Omitting the key clears the override. */
  onPatch: (updates: ProjectWideSettings) => Promise<{ kind: string; message?: string }>
}

export function RepetitionPropagationProjectSection({
  value, orgDefault, disabled, disabledTooltip, onPatch,
}: Props) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choice: Choice = value === undefined ? "inherit" : value ? "on" : "off"

  const options = [
    { value: "inherit" as const, label: t("projectSettings.autoPropagateRepetitions.inherit") },
    { value: "on" as const, label: t("projectSettings.autoPropagateRepetitions.on") },
    { value: "off" as const, label: t("projectSettings.autoPropagateRepetitions.off") },
  ]

  // What "Organization default" currently resolves to — announced with the
  // control rather than painted on hover only, so it reaches a keyboard or
  // screen-reader user too.
  const currentDefault = orgDefault
    ? t("projectSettings.autoPropagateRepetitions.currentlyOn")
    : t("projectSettings.autoPropagateRepetitions.currentlyOff")

  async function handleChange(next: Choice) {
    setBusy(true)
    setError(null)
    // undefined clears the key — patchShared serialises the merged blob, and a
    // key set to undefined does not survive JSON, which is exactly the delete
    // the "inherit" option means.
    const result = await onPatch({
      autoPropagateRepetitions: next === "inherit" ? undefined : next === "on",
    })
    if (result.kind === "error" || result.kind === "blocked") {
      setError(result.message ?? t("projectSettings.autoPropagateRepetitions.saveFailed"))
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={
        <label htmlFor="auto-propagate-repetitions">
          {t("projectSettings.autoPropagateRepetitions.label")}
        </label>
      }
      description={t("projectSettings.autoPropagateRepetitions.description")}
      control={
        <div className="flex flex-col items-end gap-1">
          <DisabledFieldTooltip disabled={Boolean(disabled)} tooltip={disabledTooltip ?? null}>
            <Select
              items={options}
              disabled={disabled || busy}
              value={choice}
              onValueChange={(v) => void handleChange((v ?? choice) as Choice)}
            >
              {/* A span owns the hover rather than the trigger itself —
                  making a control its own tooltip trigger races that
                  control's pointer and focus handling. */}
              <Tooltip>
                <TooltipTrigger
                  delay={200}
                  closeOnClick={false}
                  render={<span className="block" />}
                >
                  <SelectTrigger
                    id="auto-propagate-repetitions"
                    className="w-52 bg-background"
                    aria-label={t("projectSettings.autoPropagateRepetitions.label")}
                    aria-describedby="auto-propagate-repetitions-default"
                  >
                    <SelectValue />
                  </SelectTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center">
                  {currentDefault}
                </TooltipContent>
              </Tooltip>
              <SelectContent>
                <SelectGroup>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </DisabledFieldTooltip>
          <span id="auto-propagate-repetitions-default" className="sr-only">
            {currentDefault}
          </span>
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
