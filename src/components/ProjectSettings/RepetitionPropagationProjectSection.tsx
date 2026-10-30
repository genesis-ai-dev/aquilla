// AQU-1391: this project's answer to "does validating a cell fill in its
// repetitions". AQU-2263: it follows the organization unless the project sets
// its own, with the same menu and switch as "Count headings" beside it
// (OrgDefaultSwitchRow).

import type { ReactNode } from "react"
import { OrgDefaultSwitchRow } from "./OrgDefaultSwitchRow"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

interface Props {
  /** The project's stored answer. Undefined = follows the organization. */
  value: boolean | undefined
  /** The org's effective default, shown while the project follows it. */
  orgDefault: boolean
  disabled?: boolean
  disabledTooltip?: ReactNode
  /** Patches the shared settings blob. Omitting the key clears the override. */
  onPatch: (updates: ProjectWideSettings) => Promise<{ kind: string; message?: string }>
}

export function RepetitionPropagationProjectSection({ value, orgDefault, disabled, disabledTooltip, onPatch }: Props) {
  const t = useT()
  return (
    <OrgDefaultSwitchRow
      id="auto-propagate-repetitions"
      settingKey="autoPropagateRepetitions"
      label={t("projectSettings.autoPropagateRepetitions.label")}
      description={t("projectSettings.autoPropagateRepetitions.description")}
      value={value}
      orgDefault={orgDefault}
      disabled={disabled}
      disabledTooltip={disabledTooltip}
      saveFailed={t("projectSettings.autoPropagateRepetitions.saveFailed")}
      onPatch={onPatch}
    />
  )
}
