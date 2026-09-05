// AQU-1083: this project's answer to "do headings count toward progress",
// with a third option that defers to the organization.
//
// Three states, and the third one is an ABSENCE. "Use the organization
// default" is the key not being stored at all — there is no null to write,
// because the resolver has no meaning for one. Choosing it therefore deletes
// the key, which the server treats as a real change a project lead may make.
//
// It patches the shared settings blob DIRECTLY rather than going through the
// page's draft/baseline machinery, and that is deliberate. That machinery
// seeds itself once from the project record, and the page fetches the project
// without the settings overlay — which is why `allowTrackEditing` and
// `allowLineCreation` render permanently off no matter what is stored. A
// tri-state seeded the same way would inherit the same bug and, worse, would
// read "inherit" for a project that had explicitly chosen something.

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

type Choice = "inherit" | "count" | "exclude"

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

export function StructuralCellsProjectSection({
  value, orgDefault, disabled, disabledTooltip, onPatch,
}: Props) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choice: Choice = value === undefined ? "inherit" : value ? "count" : "exclude"

  const options = [
    { value: "inherit" as const, label: t("projectSettings.structuralCells.inherit") },
    { value: "count" as const, label: t("projectSettings.structuralCells.count") },
    { value: "exclude" as const, label: t("projectSettings.structuralCells.exclude") },
  ]

  // What "Organization default" currently resolves to. The option says only
  // "Organization default" — spelling the answer into the label made it a
  // sentence where its two siblings are two words (Sam, 2026-09-05) — so the
  // answer rides alongside instead.
  //
  // On the TRIGGER, so it is readable without opening the menu. Not on the
  // option as well: a tooltip inside an open select menu fights that menu's
  // own portal and focus handling, and the trigger is where a reader looks
  // anyway. And it is a real description, not only a hover — a tooltip is
  // invisible to a keyboard or screen reader, which would leave those users
  // an option that says nothing at all.
  const currentDefault = orgDefault
    ? t("projectSettings.structuralCells.currentlyCounting")
    : t("projectSettings.structuralCells.currentlyExcluding")

  async function handleChange(next: Choice) {
    setBusy(true)
    setError(null)
    // undefined clears the key — patchShared serialises the merged blob, and a
    // key set to undefined does not survive JSON, which is exactly the delete
    // the "inherit" option means.
    const result = await onPatch({
      countStructuralCells: next === "inherit" ? undefined : next === "count",
    })
    if (result.kind === "error" || result.kind === "blocked") {
      setError(result.message ?? t("projectSettings.structuralCells.saveFailed"))
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={
        <label htmlFor="count-structural-cells">
          {t("projectSettings.structuralCells.label")}
        </label>
      }
      description={t("projectSettings.structuralCells.description")}
      control={
        <div className="flex flex-col items-end gap-1">
          <DisabledFieldTooltip disabled={Boolean(disabled)} tooltip={disabledTooltip ?? null}>
            <Select
              items={options}
              disabled={disabled || busy}
              value={choice}
              onValueChange={(v) => void handleChange((v ?? choice) as Choice)}
            >
              {/* A span owns the hover rather than the trigger itself. Making
                  a control its own tooltip trigger races that control's
                  pointer and focus handling — the same reason
                  DisabledFieldTooltip beside this wraps in a span. */}
              <Tooltip>
                <TooltipTrigger
                  delay={200}
                  closeOnClick={false}
                  render={<span className="block" />}
                >
                  <SelectTrigger
                    id="count-structural-cells"
                    className="w-52 bg-background"
                    aria-label={t("projectSettings.structuralCells.label")}
                    aria-describedby="count-structural-cells-default"
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
          {/* Announced with the control rather than painted on hover only. */}
          <span id="count-structural-cells-default" className="sr-only">
            {currentDefault}
          </span>
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
