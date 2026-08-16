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
import type { MessageKey } from "@/lib/i18n/messages/en"

/**
 * Catalog keys, not display strings — resolved with `t()` at render time
 * below. Each reuses an identical-text key already established elsewhere
 * (org.orgHome.stalled/overdue/statusFilter.all, org.overview.
 * needsAttentionHeading) rather than minting duplicates for the same words.
 */
const STATUS_FILTERS: { value: StatusFilter; labelKey: MessageKey }[] = [
  { value: "all", labelKey: "org.orgHome.statusFilter.all" },
  { value: "stalled", labelKey: "org.orgHome.stalled" },
  { value: "overdue", labelKey: "org.orgHome.overdue" },
  { value: "attention", labelKey: "org.overview.needsAttentionHeading" },
]

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
