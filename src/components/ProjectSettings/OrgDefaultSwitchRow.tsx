// AQU-2263: an on/off project setting that follows its organization unless
// the project sets its own — "Count headings" and "Auto-propagate
// repetitions". The same two choices every other organization default on
// Project settings uses (OrgDefaultSource), beside the switch itself.
//
// The switch always shows the value in force. While the project follows the
// organization it shows the organization's answer, and flipping it sets this
// project's own value in one step, which turns the menu to "Set for this
// project". Choosing "Organization default" removes the project's value.
//
// It patches the shared settings blob DIRECTLY rather than going through the
// page's draft/baseline machinery. That machinery seeds itself once from the
// project record, which is fetched without the settings overlay, so a setting
// seeded the same way would read "follows the organization" for a project
// that had chosen something. "Follows the organization" is the key being
// absent, so choosing it writes undefined, which does not survive JSON.

import { useState, type ReactNode } from "react"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { OrgDefaultSource, orgBooleanOptionLabel } from "./OrgDefaultSource"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

export interface OrgDefaultSwitchRowProps {
  /** The switch's id; the menu is `${id}-source`. */
  id: string
  settingKey: "countStructuralCells" | "autoPropagateRepetitions"
  label: string
  description: ReactNode
  /** The project's stored answer. Undefined = follows the organization. */
  value: boolean | undefined
  /** The organization's answer, defaults applied. */
  orgDefault: boolean
  disabled?: boolean
  disabledTooltip?: ReactNode
  /** What to say when the save fails without a reason of its own. */
  saveFailed: string
  /** Patches the shared settings blob. */
  onPatch: (updates: ProjectWideSettings) => Promise<{ kind: string; message?: string }>
}

export function OrgDefaultSwitchRow({
  id, settingKey, label, description, value, orgDefault, disabled, disabledTooltip, saveFailed, onPatch,
}: OrgDefaultSwitchRowProps) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inherited = value === undefined
  const effective = value ?? orgDefault

  async function write(next: boolean | undefined) {
    setBusy(true)
    setError(null)
    const result = await onPatch({ [settingKey]: next })
    if (result.kind === "error" || result.kind === "blocked") setError(result.message ?? saveFailed)
    setBusy(false)
  }

  const locked = Boolean(disabled) && disabledTooltip != null
  return (
    <SettingsRow
      label={<label htmlFor={id}>{label}</label>}
      description={description}
      control={
        <div className="flex flex-col items-end gap-1">
          <DisabledFieldTooltip disabled={locked} tooltip={locked ? disabledTooltip : null}>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <OrgDefaultSource
                id={`${id}-source`}
                settingLabel={label}
                inherited={inherited}
                orgOptionLabel={orgBooleanOptionLabel(t, orgDefault)}
                disabled={disabled || busy}
                onChange={(inherit) => void write(inherit ? undefined : effective)}
              />
              <Switch
                id={id}
                data-testid={id}
                checked={effective}
                disabled={disabled || busy}
                onCheckedChange={(checked) => void write(checked)}
                aria-label={label}
              />
            </div>
          </DisabledFieldTooltip>
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
