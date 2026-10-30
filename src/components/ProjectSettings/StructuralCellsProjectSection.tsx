// AQU-1083: this project's answer to "do headings count toward progress".
// AQU-2263: it follows the organization unless the project sets its own, with
// the same "Organization default / Set for this project" menu every other
// organization default uses, beside a switch that can be flipped straight away
// (OrgDefaultSwitchRow, which also says why it patches the shared blob).

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

export function StructuralCellsProjectSection({ value, orgDefault, disabled, disabledTooltip, onPatch }: Props) {
  const t = useT()
  return (
    <OrgDefaultSwitchRow
      id="count-structural-cells"
      settingKey="countStructuralCells"
      label={t("projectSettings.structuralCells.label")}
      description={t("projectSettings.structuralCells.description")}
      value={value}
      orgDefault={orgDefault}
      disabled={disabled}
      disabledTooltip={disabledTooltip}
      saveFailed={t("projectSettings.structuralCells.saveFailed")}
      onPatch={onPatch}
    />
  )
}
