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
    {
      value: "inherit" as const,
      label: orgDefault
        ? t("projectSettings.structuralCells.inheritCounting")
        : t("projectSettings.structuralCells.inheritExcluding"),
    },
    { value: "count" as const, label: t("projectSettings.structuralCells.count") },
    { value: "exclude" as const, label: t("projectSettings.structuralCells.exclude") },
  ]

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
              <SelectTrigger
                id="count-structural-cells"
                className="w-64 bg-background"
                aria-label={t("projectSettings.structuralCells.label")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </DisabledFieldTooltip>
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
