import { ChevronDownIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { resolveRoleName } from "@/lib/frontier/roles"
import type { StatusFilter } from "@/hooks/useOrgPortfolio"
import { STATUS_FILTERS } from "./project-status-filter"
import {
  PM_FILTER_ALL,
  PM_FILTER_MINE,
  PM_FILTER_UNASSIGNED,
  pmFilterFor,
  type PmFilter,
} from "./project-pm-filter"
import { ROLE_FILTER_ALL, roleFilterFor, type RoleFilter } from "./project-role-filter"
import {
  UPDATED_FILTER_ANY,
  UPDATED_FILTER_WINDOW_DAYS,
  updatedFilterFor,
  type UpdatedFilter,
} from "./project-updated-filter"

/**
 * AQU-1044 — the org Projects toolbar's four narrowing controls (Status,
 * PM, Role, Updated) folded into one "Sort by" dropdown, per HITL QA
 * feedback: one trigger, one submenu per dimension, radio items inside.
 *
 * The filtering semantics are unchanged — the same pure modules
 * (`project-pm-filter` and siblings) still derive the options and narrow the
 * rows, and every dimension still composes with the others and the search box
 * under AND. Only the chrome moved: instead of four Select triggers the
 * toolbar shows a single button; a picked value is echoed on its submenu row
 * and tallied in a badge on the trigger, so active narrowing stays visible
 * without opening anything.
 */
export function ProjectSortMenu({
  status,
  onStatusChange,
  pm,
  pmUsernames,
  showUnassignedPm,
  viewerUsername = null,
  onPmChange,
  role,
  roleNames,
  onRoleChange,
  updated,
  onUpdatedChange,
  className,
}: {
  status: StatusFilter
  onStatusChange: (value: StatusFilter) => void
  pm: PmFilter
  /** PMs present in the loaded rows, viewer excluded — see `pmFilterUsernames`. */
  pmUsernames: readonly string[]
  /** Whether any loaded row has no designated PM. */
  showUnassignedPm: boolean
  /**
   * AQU-1027: signed-in username; enables the pinned "Managed by me" option.
   * Offered even when the viewer manages nothing here, so the answer is an
   * empty table rather than the option quietly not being there.
   */
  viewerUsername?: string | null
  onPmChange: (value: PmFilter) => void
  role: RoleFilter
  /** Canonical role names present in the loaded rows — see `roleFilterNames`. */
  roleNames: readonly string[]
  onRoleChange: (value: RoleFilter) => void
  updated: UpdatedFilter
  onUpdatedChange: (value: UpdatedFilter) => void
  className?: string
}) {
  const { t } = useI18n()

  const statusItems = STATUS_FILTERS.map((filter) => ({
    value: filter.value,
    label: t(filter.labelKey),
  }))
  const pmItems = [
    { value: PM_FILTER_ALL as PmFilter, label: t("org.orgProjectsPage.pmFilter.all") },
    // AQU-1027: pinned directly under the reset default — a PM holding 50 of
    // 150 projects should not have to hunt for their own name among the rest.
    // The viewer is absent from `pmUsernames` by design (see pmFilterUsernames).
    ...(viewerUsername?.trim()
      ? [{ value: PM_FILTER_MINE as PmFilter, label: t("org.orgProjectsPage.pmFilter.mine") }]
      : []),
    ...pmUsernames.map((username) => ({ value: pmFilterFor(username), label: username })),
    // Unassigned last, mirroring the PM column's "missing sorts last" rule.
    ...(showUnassignedPm
      ? [{ value: PM_FILTER_UNASSIGNED as PmFilter, label: t("org.projectOverview.unassigned") }]
      : []),
  ]
  const roleItems = [
    { value: ROLE_FILTER_ALL as RoleFilter, label: t("org.orgProjectsPage.roleFilter.all") },
    ...roleNames.map((name) => ({ value: roleFilterFor(name), label: resolveRoleName(t, name) })),
  ]
  const updatedItems = [
    { value: UPDATED_FILTER_ANY as UpdatedFilter, label: t("org.orgProjectsPage.updatedFilter.any") },
    ...UPDATED_FILTER_WINDOW_DAYS.map((days) => ({
      value: updatedFilterFor(days),
      label: t("org.orgProjectsPage.updatedFilter.lastDays", { days }),
    })),
  ]

  const activeCount = [
    status !== "all",
    pm !== PM_FILTER_ALL,
    role !== ROLE_FILTER_ALL,
    updated !== UPDATED_FILTER_ANY,
  ].filter(Boolean).length

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="project-sort-menu"
        className={cn(
          // Same chrome as a toolbar SelectTrigger, so the one control left
          // in the row doesn't read as a different kind of widget.
          "flex h-8 w-fit items-center gap-1.5 rounded-lg border border-input py-2 pe-2 ps-2.5 text-sm text-foreground whitespace-nowrap outline-none select-none hover:bg-accent/40 focus-visible:border-ring data-popup-open:bg-accent/40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
          className,
        )}
      >
        {t("org.orgHome.projectsPanel.sortByLabel")}
        {activeCount > 0 && (
          <span
            data-testid="project-sort-menu-count"
            className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
          >
            {activeCount}
          </span>
        )}
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-44">
        <FilterSubmenu
          label={t("org.orgHome.projectsPanel.statusLabel")}
          current={status}
          defaultValue={"all" as StatusFilter}
          items={statusItems}
          onChange={onStatusChange}
        />
        <FilterSubmenu
          label={t("org.orgProjectsDataTable.pmColumn")}
          current={pm}
          defaultValue={PM_FILTER_ALL as PmFilter}
          items={pmItems}
          onChange={onPmChange}
        />
        <FilterSubmenu
          label={t("common.roleLabel")}
          current={role}
          defaultValue={ROLE_FILTER_ALL as RoleFilter}
          items={roleItems}
          onChange={onRoleChange}
        />
        <FilterSubmenu
          label={t("org.orgProjectsDataTable.updatedColumn")}
          current={updated}
          defaultValue={UPDATED_FILTER_ANY as UpdatedFilter}
          items={updatedItems}
          onChange={onUpdatedChange}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One dimension of the menu: a submenu row named for the dimension, echoing
 * the picked value (muted, only when off the default), with radio items
 * inside. Radio items keep the menu open on pick (Base UI's default), so
 * several dimensions can be set in one visit.
 */
function FilterSubmenu<V extends string>({
  label,
  current,
  defaultValue,
  items,
  onChange,
}: {
  label: string
  current: V
  defaultValue: V
  items: { value: V; label: string }[]
  onChange: (value: V) => void
}) {
  const currentLabel = items.find((item) => item.value === current)?.label
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex-1">{label}</span>
        {current !== defaultValue && currentLabel != null && (
          <span className="max-w-40 truncate ps-3 text-xs text-muted-foreground">
            {currentLabel}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-40">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(next) => onChange((next as V) ?? defaultValue)}
        >
          {items.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
