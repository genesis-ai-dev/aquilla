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
import {
  PM_FILTER_ALL,
  PM_FILTER_UNASSIGNED,
  pmFilterFor,
  type PmFilter,
} from "./project-pm-filter"

/**
 * AQU-1040 — designated-PM filter for the Projects toolbar, sibling to
 * `ProjectStatusFilter` (same Select chrome, same toolbar row).
 *
 * Options are data-derived: the caller passes the PMs actually present in the
 * loaded rows, so the list never shows a stale or invented person. Unassigned
 * is offered only when some loaded row has no PM.
 */
export function ProjectPmFilter({
  value,
  usernames,
  showUnassigned,
  onValueChange,
  className,
}: {
  value: PmFilter
  /** PMs present in the loaded rows — see `pmFilterUsernames`. */
  usernames: readonly string[]
  /** Whether any loaded row has no designated PM. */
  showUnassigned: boolean
  onValueChange: (value: PmFilter) => void
  className?: string
}) {
  const { t } = useI18n()
  const items = [
    { value: PM_FILTER_ALL as PmFilter, label: t("org.orgProjectsPage.pmFilter.all") },
    ...usernames.map((username) => ({ value: pmFilterFor(username), label: username })),
    // Unassigned last, mirroring the PM column's "missing sorts last" rule.
    ...(showUnassigned
      ? [{ value: PM_FILTER_UNASSIGNED as PmFilter, label: t("org.projectOverview.unassigned") }]
      : []),
  ]
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onValueChange((next as PmFilter) ?? PM_FILTER_ALL)}
    >
      <SelectTrigger
        aria-label={t("org.orgProjectsPage.pmFilterAria")}
        data-testid="project-pm-filter"
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
