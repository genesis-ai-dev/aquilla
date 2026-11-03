// AQU-2263: who can see this project's member list and each member's
// progress, in Project settings → Members. The organization sets both
// (Settings → Security) and a project may only make them STRICTER (AQU-1771),
// so each picker offers the organization's level, named "Organization
// default (…)", and the stricter ones. This is a second home for the same two
// values the dashboard's Members and Team badges set, not a move: the badges
// stay, and both write the same keys.
//
// The rules are the server's (visibilityFloorWriteRefusal): a stored value is
// only kept when it is stricter than the organization's, choosing the
// organization's own level removes the project's value, and only someone at or
// above a stored value may make it less strict ("Owners only" binds
// maintainers). The picker disables what the server would refuse and says why.

import { useState, type ReactNode } from "react"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { FieldError } from "@/components/ui/field"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { visibilityRolePickerLabelKey } from "@/components/org/SectionVisibilityBadge"
import { ROLE, resolveRoleName } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import type { VisibilityFloorView } from "@/lib/sync/project-org-policy"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

/** The rungs the dashboard badges offer, in order. */
const LEVELS = [ROLE.VIEWER, ROLE.CONTRIBUTOR, ROLE.PROJECT_LEAD, ROLE.MAINTAINER, ROLE.OWNER] as const

type FloorKey = "rosterViewMinRole" | "memberProgressViewMinRole"

interface Props {
  roster: VisibilityFloorView
  progress: VisibilityFloorView
  /** The caller's role on this project. */
  roleLevel: number
  /** The project settings write gate (Maintainer). */
  canEdit: boolean
  /** Why it is locked, shown like every other locked project setting. */
  disabledTooltip?: ReactNode
  onPatch: (updates: ProjectWideSettings) => Promise<PatchOutcome>
}

export function ProjectVisibilitySection({ roster, progress, roleLevel, canEdit, disabledTooltip, onPatch }: Props) {
  const t = useT()
  return (
    <SettingsGroup
      label={t("projectSettings.visibility.groupLabel")}
      description={t("projectSettings.visibility.groupDescription")}
    >
      <FloorRow
        id="project-roster-visibility"
        floorKey="rosterViewMinRole"
        label={t("projectSettings.visibility.rosterLabel")}
        description={t("projectSettings.visibility.rosterDescription")}
        floor={roster}
        roleLevel={roleLevel}
        canEdit={canEdit}
        disabledTooltip={disabledTooltip}
        onPatch={onPatch}
      />
      <FloorRow
        id="project-progress-visibility"
        floorKey="memberProgressViewMinRole"
        label={t("projectSettings.visibility.progressLabel")}
        description={t("projectSettings.visibility.progressDescription")}
        floor={progress}
        roleLevel={roleLevel}
        canEdit={canEdit}
        disabledTooltip={disabledTooltip}
        onPatch={onPatch}
      />
    </SettingsGroup>
  )
}

function FloorRow({
  id, floorKey, label, description, floor, roleLevel, canEdit, disabledTooltip, onPatch,
}: {
  id: string
  floorKey: FloorKey
  label: string
  description: string
  floor: VisibilityFloorView
  roleLevel: number
  canEdit: boolean
  disabledTooltip?: ReactNode
  onPatch: (updates: ProjectWideSettings) => Promise<PatchOutcome>
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only someone at or above the project's own value may make it less strict.
  const bindsCaller = floor.project != null && roleLevel < floor.project
  const options = LEVELS.filter((level) => level >= floor.org).map((level) => ({
    value: String(level),
    label: level === floor.org
      ? t("projectSettings.mediaDefaults.orgValue", { value: t(visibilityRolePickerLabelKey(level)) })
      : t(visibilityRolePickerLabelKey(level)),
    disabled: bindsCaller && level < (floor.project ?? 0),
  }))
  const items = options.map(({ value, label }) => ({ value, label }))

  async function choose(raw: string | null) {
    const level = Number(raw)
    if (!Number.isFinite(level) || level === floor.effective) return
    setBusy(true)
    setError(null)
    // The organization's own level means "follow the organization".
    const outcome = await onPatch({ [floorKey]: level > floor.org ? level : undefined })
    setBusy(false)
    const why = refusal(outcome, t)
    if (why) setError(why)
  }

  return (
    <SettingsRow
      saveId={floorKey}
      label={<label htmlFor={id}>{label}</label>}
      description={description}
      control={
        <div className="flex flex-col items-end gap-1">
          <DisabledFieldTooltip disabled={!canEdit} tooltip={disabledTooltip ?? null}>
            <Select
              items={items}
              value={String(floor.effective)}
              disabled={!canEdit || busy}
              onValueChange={(v) => void choose(v)}
            >
              <SelectTrigger id={id} data-testid={id} className="w-72 bg-background" aria-label={label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value} disabled={o.disabled}>{o.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </DisabledFieldTooltip>
          {canEdit && bindsCaller ? (
            <span className="text-xs text-muted-foreground" data-testid={`${id}-binds`}>
              {t("projectSettings.visibility.onlyRoleLoosens", {
                role: resolveRoleName(t, floor.project ?? ROLE.OWNER, { plural: true }),
              })}
            </span>
          ) : null}
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}

/** Why a save did not land, in the dashboard badges' words. */
function refusal(outcome: PatchOutcome, t: ReturnType<typeof useT>): string | null {
  switch (outcome.kind) {
    case "ok":
      return null
    case "conflict":
      return t("org.sync.versionConflictError")
    case "blocked":
      return outcome.reason === "offline"
        ? t("org.projectOverview.visibilitySaveOffline")
        : t("org.projectOverview.visibilitySaveForbidden")
    case "error":
      return outcome.message || t("org.projectOverview.visibilitySaveFailed")
  }
}
