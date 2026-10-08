// AQU-486: per-section visibility affordance for the org + project dashboards.
//
// Consumes the visibility floors that AQU-485 introduced (rosterViewMinRole,
// memberProgressViewMinRole) plus the pre-existing exportMinRole pattern —
// this component does not invent new permission plumbing, it makes the
// existing floor legible in place:
//   1. A small badge naming who can currently see the section ("Everyone" /
//      "Maintainers & owners" / …), so visibility is never a silent fact.
//   2. An inline "advanced" popover for a caller who can edit the floor
//      (`canEdit`) to change it right there, instead of navigating to
//      Settings.
//   3. `sectionTintClass` gives maintainer-only sections a faint tinted
//      background so the "maintainer area" reads at a glance.
//
// Deliberately dumb: it takes a role-level number in and calls back with a
// role-level number out. Callers own the actual permission source (org
// settings patch, or a static floor) and the hide/show decision.

import { useState } from "react"
import { Lock, Eye, ChevronDown, Info } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Popover,
  PopoverContent,
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { ROLE } from "@/lib/frontier/roles"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

/** Role levels this control offers — mirrors RosterProgressSection's picker. */
const VISIBILITY_ROLE_OPTIONS = [
  { level: ROLE.VIEWER, labelKey: "org.sectionVisibilityBadge.rolePickerEveryone" as MessageKey },
  { level: ROLE.CONTRIBUTOR, labelKey: "org.sectionVisibilityBadge.rolePickerContributor" as MessageKey },
  { level: ROLE.PROJECT_LEAD, labelKey: "org.sectionVisibilityBadge.rolePickerProjectLead" as MessageKey },
  { level: ROLE.MAINTAINER, labelKey: "org.sectionVisibilityBadge.rolePickerMaintainer" as MessageKey },
  { level: ROLE.OWNER, labelKey: "org.sectionVisibilityBadge.rolePickerOwner" as MessageKey },
] as const

/** Short human label for a floor, used in the badge itself. English fallback for
 *  pure-lib/test callers without access to t() — see visibilityFloorLabelKey for
 *  the localized path the component itself uses. */
export function visibilityFloorLabel(minRole: number): string {
  if (minRole <= ROLE.VIEWER) return "Everyone can see this"
  if (minRole <= ROLE.CONTRIBUTOR) return "Contributors & up can see this"
  if (minRole <= ROLE.PROJECT_LEAD) return "Project leads & up can see this"
  if (minRole <= ROLE.MAINTAINER) return "Only maintainers & owners can see this"
  return "Only owners can see this"
}

/** Catalog key for a floor's display label — see visibilityFloorLabel's own doc. */
export function visibilityFloorLabelKey(minRole: number): MessageKey {
  if (minRole <= ROLE.VIEWER) return "org.sectionVisibilityBadge.floorEveryone"
  if (minRole <= ROLE.CONTRIBUTOR) return "org.sectionVisibilityBadge.floorContributor"
  if (minRole <= ROLE.PROJECT_LEAD) return "org.sectionVisibilityBadge.floorProjectLead"
  if (minRole <= ROLE.MAINTAINER) return "org.sectionVisibilityBadge.floorMaintainer"
  return "org.sectionVisibilityBadge.floorOwner"
}

/** Catalog key for a floor's picker label ("Maintainers and owners"), for
 *  copy that names a floor mid-sentence. Same thresholds as
 *  visibilityFloorLabelKey. */
export function visibilityRolePickerLabelKey(minRole: number): MessageKey {
  if (minRole <= ROLE.VIEWER) return "org.sectionVisibilityBadge.rolePickerEveryone"
  if (minRole <= ROLE.CONTRIBUTOR) return "org.sectionVisibilityBadge.rolePickerContributor"
  if (minRole <= ROLE.PROJECT_LEAD) return "org.sectionVisibilityBadge.rolePickerProjectLead"
  if (minRole <= ROLE.MAINTAINER) return "org.sectionVisibilityBadge.rolePickerMaintainer"
  return "org.sectionVisibilityBadge.rolePickerOwner"
}

/** True when a floor restricts the section beyond "everyone with access". */
export function isRestrictedFloor(minRole: number): boolean {
  return minRole > ROLE.VIEWER
}

/**
 * Background treatment for a maintainer-only (or stricter) section, so it
 * visually reads as "the maintainer area" without needing the badge text.
 * Applied by the caller alongside its normal section classes.
 */
export function sectionTintClass(minRole: number): string {
  return isRestrictedFloor(minRole)
    ? "bg-amber-50/60 dark:bg-amber-950/10 ring-1 ring-inset ring-amber-900/10 dark:ring-amber-100/10"
    : ""
}

export interface SectionVisibilityBadgeProps {
  /** Minimum role level required to see this section right now. */
  minRole: number
  /**
   * True when the current caller may change this floor. When false (or
   * `onChangeMinRole` is omitted) the badge is a plain, non-interactive label
   * — no advanced control leaks to callers who can't use it.
   */
  canEdit?: boolean
  /** Persists the new floor. Omit to render the badge read-only. */
  onChangeMinRole?: (nextMinRole: number) => void | Promise<void>
  /** One-line description shown above the picker in the advanced popover. */
  description?: string
  /**
   * Lowest floor this control can actually apply (AQU-1779). Options below it
   * are disabled and never written: a section whose shown floor is the higher
   * of two settings must not offer a value that saves but cannot show.
   */
  minSelectableRole?: number
  /** Why the options below `minSelectableRole` are off. Whenever any option
   *  is disabled, a circled-i beside the picker's label expands it in place. */
  belowMinSelectableHint?: string
  className?: string
}

/**
 * Compact "who can see this" affordance for a dashboard section. Renders as a
 * badge; when the caller can edit the floor, the badge is a popover trigger
 * exposing an inline role-floor picker (the "advanced toggle" from AQU-486 —
 * no trip to Settings required).
 */
export function SectionVisibilityBadge({
  minRole,
  canEdit = false,
  onChangeMinRole,
  description,
  minSelectableRole,
  belowMinSelectableHint,
  className,
}: SectionVisibilityBadgeProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hintOpen, setHintOpen] = useState(false)
  const label = t(visibilityFloorLabelKey(minRole))
  const Icon = isRestrictedFloor(minRole) ? Lock : Eye
  const interactive = canEdit && typeof onChangeMinRole === "function"
  const isSelectable = (level: number) => minSelectableRole == null || level >= minSelectableRole
  const someDisabled = VISIBILITY_ROLE_OPTIONS.some((opt) => !isSelectable(opt.level))

  const badgeContent = (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-normal text-muted-foreground",
        interactive && "hover:bg-muted",
        className,
      )}
    >
      <Icon className="size-3" />
      {label}
      {interactive && <ChevronDown className="size-3" />}
    </Badge>
  )

  if (!interactive) {
    return <span data-testid="section-visibility-badge">{badgeContent}</span>
  }

  async function handleChange(value: string | null) {
    if (!value || !onChangeMinRole) return
    const next = Number(value)
    if (!Number.isFinite(next) || next === minRole || !isSelectable(next)) return
    setBusy(true)
    try {
      await onChangeMinRole(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(
          <button
            type="button"
            data-testid="section-visibility-badge"
            className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={t("org.sectionVisibilityBadge.changeVisibilityAriaLabel", { label })}
          >
            {badgeContent}
          </button>
        )}
      />
      <PopoverContent align="end" className="w-64">
        <Field>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel className="text-xs font-medium">{t("org.sectionVisibilityBadge.whoCanSeeLabel")}</FieldLabel>
            {/* A click, not a hover: the disabled options themselves take no
                pointer events, and a tooltip inside this popover would not
                reach touch screens. */}
            {someDisabled && belowMinSelectableHint && (
              <button
                type="button"
                data-testid="section-visibility-min-info"
                className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground data-[state=open]:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label={t("org.sectionVisibilityBadge.whyOptionsOffAriaLabel")}
                aria-expanded={hintOpen}
                data-state={hintOpen ? "open" : "closed"}
                aria-controls="section-visibility-min-hint"
                onClick={() => setHintOpen((v) => !v)}
              >
                <Info className="size-3.5" aria-hidden />
              </button>
            )}
          </div>
          <Select
            items={VISIBILITY_ROLE_OPTIONS.map((opt) => ({ value: String(opt.level), label: t(opt.labelKey) }))}
            value={String(minRole)}
            onValueChange={(v) => void handleChange(v)}
            disabled={busy}
          >
            <SelectTrigger aria-label={t("org.sectionVisibilityBadge.whoCanSeeLabel")} size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {VISIBILITY_ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.level} value={String(opt.level)} disabled={!isSelectable(opt.level)}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {description && <FieldDescription className="text-xs">{description}</FieldDescription>}
          {/* Stays mounted so it can animate both ways: the 0fr→1fr grid row
              grows to the text's own height without measuring it, and the
              negative margin cancels the Field's gap while it is shut. */}
          {someDisabled && belowMinSelectableHint && (
            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none",
                hintOpen ? "grid-rows-[1fr] opacity-100" : "-mt-1.5 grid-rows-[0fr] opacity-0",
              )}
              data-state={hintOpen ? "open" : "closed"}
              data-testid="section-visibility-min-hint"
              aria-hidden={!hintOpen}
              inert={!hintOpen}
            >
              <FieldDescription id="section-visibility-min-hint" className="min-h-0 overflow-hidden text-xs">
                {belowMinSelectableHint}
              </FieldDescription>
            </div>
          )}
        </Field>
      </PopoverContent>
    </Popover>
  )
}

export interface SectionVisibilityGateProps {
  /** Minimum role level required to see this section. */
  minRole: number
  /** The caller's effective role level, or null/undefined when unknown yet. */
  viewerRoleLevel: number | null | undefined
  /**
   * True once the floor is known to be settled (e.g. org settings fetched).
   * Before this, render nothing rather than flashing content open then
   * hiding it — mirrors useOrgSettings' canViewRoster/canViewMemberProgress
   * pre-fetch behavior.
   */
  ready?: boolean
  children: React.ReactNode
}

/**
 * Hard gate for a restricted section: renders nothing at all (no empty
 * placeholder) when the viewer's role doesn't meet `minRole`, so a
 * lower-role account can't tell the section exists. This is the enforcement
 * half of the pair; `SectionVisibilityBadge` is the disclosure half.
 */
export function SectionVisibilityGate({
  minRole,
  viewerRoleLevel,
  ready = true,
  children,
}: SectionVisibilityGateProps) {
  if (!ready) return null
  if (viewerRoleLevel == null || viewerRoleLevel < minRole) return null
  return <>{children}</>
}
