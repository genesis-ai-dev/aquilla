import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { StatusFilter } from "@/hooks/useOrgPortfolio"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { STATUS_FILTERS } from "./project-status-filter"

export function ProjectStatusFilter({
  value,
  onValueChange,
  className,
}: {
  value: StatusFilter
  onValueChange: (value: StatusFilter) => void
  className?: string
}) {
  const { t } = useI18n()
  const items = STATUS_FILTERS.map((filter) => ({ value: filter.value, label: t(filter.labelKey) }))
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onValueChange((next as StatusFilter) ?? "all")}
    >
      <SelectTrigger
        aria-label={t("org.orgHome.projectsPanel.statusFilterAria")}
        className={cn("bg-background", className)}
      >
        <SelectValue className="flex-none" />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {items.map((filter) => (
            <SelectItem key={filter.value} value={filter.value}>
              {filter.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
