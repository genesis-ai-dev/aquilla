// AQU-1768: "Organization default (…)" or "Set for this project", beside a
// media setting on Project settings. The same two choices AQU-1771 put beside
// the validator counts.
//
// The setting's own control stays on screen either way and shows the value in
// force: while the project follows the organization it is disabled and shows
// the organization's value, so nobody has to open the menu to learn what
// "Organization default" means today. Choosing "Set for this project" starts
// from that same value, so nothing changes until the control is edited.

import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { useT } from "@/lib/i18n/I18nProvider"

interface OrgDefaultSourceProps {
  id: string
  /** The setting's own label; names the menu for screen readers. */
  settingLabel: string
  /** True while the project has no value of its own. */
  inherited: boolean
  /** The finished "Organization default (…)" text for this setting. */
  orgOptionLabel: string
  disabled?: boolean
  /** true → follow the organization (clear the project's value). */
  onChange: (inherit: boolean) => void
}

export function OrgDefaultSource({
  id, settingLabel, inherited, orgOptionLabel, disabled, onChange,
}: OrgDefaultSourceProps) {
  const t = useT()
  const items = [
    { value: "inherit", label: orgOptionLabel },
    { value: "custom", label: t("projectSettings.validation.customOption") },
  ]
  const current = inherited ? "inherit" : "custom"
  return (
    <Select
      items={items}
      disabled={disabled}
      value={current}
      onValueChange={(v) => {
        if (!v || v === current) return
        onChange(v === "inherit")
      }}
    >
      <SelectTrigger
        id={id}
        data-testid={id}
        className="w-56 bg-background"
        aria-label={t("projectSettings.mediaDefaults.sourceAria", { setting: settingLabel })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

/** The "Organization default (on|off)" text for an on/off setting. */
export function orgBooleanOptionLabel(t: ReturnType<typeof useT>, value: boolean): string {
  return value ? t("projectSettings.mediaDefaults.orgOn") : t("projectSettings.mediaDefaults.orgOff")
}
