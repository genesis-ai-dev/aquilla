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

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "stalled", label: "Stalled" },
  { value: "overdue", label: "Overdue" },
  { value: "attention", label: "Needs attention" },
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
  return (
    <Select
      items={STATUS_FILTERS}
      value={value}
      onValueChange={(next) => onValueChange((next as StatusFilter) ?? "all")}
    >
      <SelectTrigger
        aria-label="Project status filter"
        className={cn("bg-background", className)}
      >
        <SelectValue className="flex-none" />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {STATUS_FILTERS.map((filter) => (
            <SelectItem key={filter.value} value={filter.value}>
              {filter.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
