import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { resolveRoleName } from "@/lib/frontier/roles"
import { ROLE_FILTER_ALL, roleFilterFor, type RoleFilter } from "./project-role-filter"

/**
 * AQU-1042 — viewer-role filter for the Projects toolbar, sibling to
 * `ProjectStatusFilter` and `ProjectPmFilter` (same Select chrome, same
 * toolbar row).
 *
 * Options are data-derived: the caller passes the roles actually present in
 * the loaded rows (ladder-ordered by `roleFilterNames`), so the list never
 * shows a role no row holds. Labels resolve through the same catalog keys the
 * Role column's `<RoleLabel>` uses, so the filter and the column always read
 * identically.
 */
export function ProjectRoleFilter({
  value,
  names,
  onValueChange,
  className,
}: {
  value: RoleFilter
  /** Canonical role names present in the loaded rows — see `roleFilterNames`. */
  names: readonly string[]
  onValueChange: (value: RoleFilter) => void
  className?: string
}) {
  const { t } = useI18n()
  const items = [
    { value: ROLE_FILTER_ALL as RoleFilter, label: t("org.orgProjectsPage.roleFilter.all") },
    ...names.map((name) => ({ value: roleFilterFor(name), label: resolveRoleName(t, name) })),
  ]
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onValueChange((next as RoleFilter) ?? ROLE_FILTER_ALL)}
    >
      <SelectTrigger
        aria-label={t("org.orgProjectsPage.roleFilterAria")}
        data-testid="project-role-filter"
        className={cn("bg-background", className)}
      >
        <SelectValue className="flex-none" />
      </SelectTrigger>
      <SelectContent align="start">
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
