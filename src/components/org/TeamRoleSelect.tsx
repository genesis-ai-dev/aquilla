/**
 * AQU-1352 P2 (spec §3.1, §3.4): a member's team-scope role on TeamDetail.
 *
 * Inherit (none) / Viewer / Project Lead / Maintainer. A non-inherit role
 * flows to every project attached to the team; Project Lead+ may create
 * projects into the team. Callers who cannot edit see the label read-only.
 * Never shows numeric levels.
 */
import { useState } from "react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { RoleLabel } from "@/components/RoleLabel"
import { resolveRoleName, ROLE } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"

const INHERIT = "inherit"
/** Spec §3.4: the only team-scope roles, highest first. */
export const TEAM_ROLE_LEVELS = [ROLE.MAINTAINER, ROLE.PROJECT_LEAD, ROLE.VIEWER] as const

interface TeamRoleSelectProps {
  username: string
  value: number | null
  canEdit: boolean
  /** Highest level the caller may grant (their own). */
  maxLevel: number
  onChange: (roleLevel: number | null) => Promise<void>
}

export function TeamRoleSelect({ username, value, canEdit, maxLevel, onChange }: TeamRoleSelectProps) {
  const t = useT()
  const [busy, setBusy] = useState(false)

  if (!canEdit) {
    return value == null ? (
      <span className="text-sm text-muted-foreground">{t("org.teamDetail.teamRoleInherit")}</span>
    ) : (
      <RoleLabel name={value} />
    )
  }

  const options = TEAM_ROLE_LEVELS.filter((l) => l <= maxLevel || l === value)
  const items = [
    { value: INHERIT, label: t("org.teamDetail.teamRoleInherit") },
    ...options.map((l) => ({ value: String(l), label: resolveRoleName(t, l) })),
  ]

  return (
    <Select
      items={items}
      value={value == null ? INHERIT : String(value)}
      disabled={busy}
      onValueChange={(next) => {
        if (next == null) return
        const level = next === INHERIT ? null : Number(next)
        if (level === value) return
        setBusy(true)
        void onChange(level).finally(() => setBusy(false))
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={t("org.teamDetail.teamRoleForAriaLabel", { name: username })}
        data-testid={`team-role-${username}`}
      >
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
  )
}
