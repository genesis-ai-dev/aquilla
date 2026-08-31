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
  UPDATED_FILTER_ANY,
  UPDATED_FILTER_WINDOW_DAYS,
  updatedFilterFor,
  type UpdatedFilter,
} from "./project-updated-filter"

/**
 * AQU-1043 — last-edit recency filter for the Projects toolbar, sibling to
 * `ProjectStatusFilter`, `ProjectPmFilter` and `ProjectRoleFilter` (same Select
 * chrome, same toolbar row).
 *
 * Options are fixed windows rather than data-derived, so the control reads the
 * same on every portfolio and "any time" is always the default — there is no
 * option that can go stale, and so nothing for the caller to pass in.
 */
export function ProjectUpdatedFilter({
  value,
  onValueChange,
  className,
}: {
  value: UpdatedFilter
  onValueChange: (value: UpdatedFilter) => void
  className?: string
}) {
  const { t } = useI18n()
  const items = [
    { value: UPDATED_FILTER_ANY as UpdatedFilter, label: t("org.orgProjectsPage.updatedFilter.any") },
    ...UPDATED_FILTER_WINDOW_DAYS.map((days) => ({
      value: updatedFilterFor(days),
      label: t("org.orgProjectsPage.updatedFilter.lastDays", { days }),
    })),
  ]
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onValueChange((next as UpdatedFilter) ?? UPDATED_FILTER_ANY)}
    >
      <SelectTrigger
        aria-label={t("org.orgProjectsPage.updatedFilterAria")}
        data-testid="project-updated-filter"
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
