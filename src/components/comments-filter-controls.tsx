// Filter bar for a comment list — the project Comments page and, since
// AQU-1958, the org-wide comments view and the Export action next to it.
//
// Extracted from CommentsPage.tsx so both surfaces filter identically. The
// org-only controls (project picker, date range) appear only when the caller
// passes them, so the project page's bar is unchanged.

import { useState } from "react"
import { Download, RefreshCw, Search, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  DatePicker,
  dateToDeadlineString,
  deadlineStringToDate,
} from "@/components/ui/date-picker"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import {
  countActiveFilters,
  DEFAULT_FILTER,
  type FilterState,
  type SortOrder,
} from "./comments-page-filters"

export function sortItems(t: TFunction): { value: SortOrder; label: string }[] {
  return [
    { value: "unresolved-first", label: t("comments.sort.unresolvedFirst") },
    { value: "recent-activity", label: t("comments.sort.recentActivity") },
    { value: "creation", label: t("comments.sort.newest") },
  ]
}

export interface CommentsFilterControlsProps {
  filter: FilterState
  onChange: (next: FilterState) => void
  fileOptions: { id: string; name: string }[]
  authorOptions: { id: string; label: string }[]
  isRefreshing: boolean
  onRefresh: () => void
  /** Org-wide view only: the projects the viewer can see comments from. */
  projectOptions?: { id: string; name: string }[]
  /** Org-wide view only: show the thread-start date range filter. */
  showDateRange?: boolean
  /** Download the visible list. Omitted ⇒ no Export button. */
  onExport?: () => void
  /** Nothing on screen to export yet (still loading, or an empty list). */
  exportDisabled?: boolean
}

const filterLabelClass = "font-normal text-muted-foreground"
/** Matches FieldGroup `gap-3` so select popups sit the same distance from their trigger. */
const FILTER_MENU_GAP_PX = 12

/** Base UI treats "" as no value (`data-placeholder`), which mutes the trigger. */
const ALL_SELECT_VALUE = "__all__"

function toSelectValue(value: string) {
  return value === "" ? ALL_SELECT_VALUE : value
}

function fromSelectValue(value: string | null) {
  return value == null || value === ALL_SELECT_VALUE ? "" : value
}

function FilterSelectRow({
  id,
  label,
  items,
  value,
  onValueChange,
  side = "bottom",
}: {
  id: string
  label: string
  items: { value: string; label: string }[]
  value: string
  onValueChange: (value: string) => void
  side?: "top" | "bottom"
}) {
  const selectItems = items.map((item) => ({
    ...item,
    value: toSelectValue(item.value),
  }))
  return (
    <Field orientation="horizontal" className="items-center justify-between gap-3">
      <FieldLabel htmlFor={id} className={filterLabelClass}>
        {label}
      </FieldLabel>
      <Select
        items={selectItems}
        value={toSelectValue(value)}
        onValueChange={(next) => onValueChange(fromSelectValue(next))}
      >
        <SelectTrigger id={id} size="sm" aria-label={label}>
          <SelectValue className="truncate" />
        </SelectTrigger>
        <SelectContent
          align="end"
          side={side}
          sideOffset={FILTER_MENU_GAP_PX}
        >
          <SelectGroup>
            {selectItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

function FilterDateRow({
  id,
  label,
  value,
  onValueChange,
}: {
  id: string
  label: string
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={id} className={filterLabelClass}>
        {label}
      </FieldLabel>
      <DatePicker
        id={id}
        value={deadlineStringToDate(value)}
        onChange={(date) => onValueChange(date ? dateToDeadlineString(date) : "")}
      />
    </Field>
  )
}

export function CommentsFilterControls({
  filter,
  onChange,
  fileOptions,
  authorOptions,
  isRefreshing,
  onRefresh,
  projectOptions,
  showDateRange = false,
  onExport,
  exportDisabled = false,
}: CommentsFilterControlsProps) {
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const sortItemsList = sortItems(t)
  const allFilesLabel = t("comments.filter.allFiles")
  const anyoneLabel = t("comments.filter.anyone")
  const showResolvedLabel = t("comments.filter.showResolved")
  const activeFilterCount = countActiveFilters(filter)
  const canReset = activeFilterCount > 0 || filter.sort !== DEFAULT_FILTER.sort
  const hasFiles = fileOptions.length > 0
  const hasAuthors = authorOptions.length > 0
  const hasProjects = (projectOptions?.length ?? 0) > 0

  return (
    <div className="flex items-center gap-2">
      <InputGroup className="h-8 flex-1 bg-card">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          className="text-sm"
          placeholder={t("comments.filter.searchPlaceholder")}
          value={filter.search}
          onChange={(e) => onChange({ ...filter, search: e.target.value })}
        />
      </InputGroup>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <AppTooltip
          content={t("comments.filter.filtersButton")}
          side="bottom"
          disabled={menuOpen}
        >
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="bg-card"
                aria-label={t("comments.filter.filtersButton")}
                aria-pressed={activeFilterCount > 0}
              >
                <Settings2 />
              </Button>
            }
          />
        </AppTooltip>
        <PopoverContent
          align="end"
          side="bottom"
          sideOffset={4}
          className="w-72 gap-0 p-0"
          data-testid="comments-filters-popover"
        >
          <PopoverTitle className="sr-only">{t("comments.filter.filtersButton")}</PopoverTitle>
          <FieldGroup className="gap-3 p-2.5">
            <FilterSelectRow
              id="comments-filter-sort"
              label={t("comments.filter.sortLabel")}
              items={sortItemsList}
              value={filter.sort}
              onValueChange={(value) => onChange({ ...filter, sort: value as SortOrder })}
              side={!hasProjects && !hasFiles && !hasAuthors ? "top" : "bottom"}
            />
            <Field orientation="horizontal">
              <FieldLabel htmlFor="comments-filter-show-resolved" className={filterLabelClass}>
                {showResolvedLabel}
              </FieldLabel>
              <Switch
                id="comments-filter-show-resolved"
                checked={filter.showResolved}
                onCheckedChange={(checked) => onChange({ ...filter, showResolved: checked })}
                aria-label={showResolvedLabel}
              />
            </Field>
            {hasProjects && (
              <FilterSelectRow
                id="comments-filter-project"
                label={t("common.project")}
                items={[
                  { value: "", label: t("comments.filter.allProjects") },
                  ...(projectOptions ?? []).map((project) => ({
                    value: project.id,
                    label: project.name,
                  })),
                ]}
                value={filter.projectId}
                // AQU-1958: the file picker lists files across every project,
                // so a project filter and a file filter from another project
                // would show nothing. Picking a project clears the file.
                onValueChange={(value) => onChange({ ...filter, projectId: value, fileId: "" })}
              />
            )}
            {hasFiles && (
              <FilterSelectRow
                id="comments-filter-file"
                label={t("common.file")}
                items={[
                  { value: "", label: allFilesLabel },
                  ...fileOptions.map((file) => ({ value: file.id, label: file.name })),
                ]}
                value={filter.fileId}
                onValueChange={(value) => onChange({ ...filter, fileId: value })}
                side={!hasAuthors ? "top" : "bottom"}
              />
            )}
            {hasAuthors && (
              <FilterSelectRow
                id="comments-filter-author"
                label={t("comments.filter.authorLabel")}
                items={[
                  { value: "", label: anyoneLabel },
                  ...authorOptions.map((author) => ({ value: author.id, label: author.label })),
                ]}
                value={filter.authorId}
                onValueChange={(value) => onChange({ ...filter, authorId: value })}
              />
            )}
            {hasAuthors && (
              <FilterSelectRow
                id="comments-filter-participant"
                label={t("comments.filter.participantLabel")}
                items={[
                  { value: "", label: anyoneLabel },
                  ...authorOptions.map((author) => ({ value: author.id, label: author.label })),
                ]}
                value={filter.participant}
                onValueChange={(value) => onChange({ ...filter, participant: value })}
                side="top"
              />
            )}
            {showDateRange && (
              <>
                <FilterDateRow
                  id="comments-filter-from"
                  label={t("comments.filter.fromLabel")}
                  value={filter.from}
                  onValueChange={(value) => onChange({ ...filter, from: value })}
                />
                <FilterDateRow
                  id="comments-filter-to"
                  label={t("comments.filter.toLabel")}
                  value={filter.to}
                  onValueChange={(value) => onChange({ ...filter, to: value })}
                />
              </>
            )}
          </FieldGroup>
          {canReset && (
            <>
              <Separator />
              <div className="flex justify-end p-2.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-foreground"
                  onClick={() => onChange(DEFAULT_FILTER)}
                >
                  {t("common.reset")}
                </Button>
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
      {onExport && (
        <AppTooltip content={t("comments.export.csv")} side="bottom">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="bg-card"
            onClick={onExport}
            disabled={exportDisabled}
            aria-label={t("comments.export.csv")}
            data-testid="comments-export-csv"
          >
            <Download />
          </Button>
        </AppTooltip>
      )}
      <AppTooltip content={t("common.refresh")} side="bottom" align="end">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="bg-card"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label={t("common.refresh")}
        >
          {isRefreshing ? <Spinner /> : <RefreshCw />}
        </Button>
      </AppTooltip>
    </div>
  )
}
