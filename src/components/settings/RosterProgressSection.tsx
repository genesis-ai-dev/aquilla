// AQU-485: org-level roster + member-progress visibility controls.
//
// Two independent, configurable read-permission floors, generalizing the
// AQU-253 exportMinRole pattern:
//   - rosterViewMinRole:        who can see the member list + count
//   - memberProgressViewMinRole: who can see per-member progress/productivity
//
// Both default to Maintainer when unset — safe for sensitive teams that
// don't want to reveal who/how many are on a project, or what each person
// did, even to their own members. Displayed on /settings/security. Editable
// only by org owners — stricter than the general MAINTAINER settings-write
// gate, mirroring exportMinRole's EXPORT_FLOOR_WRITE_MIN_ROLE
// (auth-worker/src/routes/org-settings.ts).
//
// AQU-498: consumed by ProjectOverview's Team card (per-teammate "Activity"
// affordance -> MemberActivityPanel), which lives inside the same
// SectionVisibilityGate this section's memberProgressViewMinRole feeds.
// SWARM-TODO(AQU-498): that view's member-selection list is currently scoped
// to assignees with open assignments (the Team card's existing roster), not
// every project member — see the SWARM-TODO in ProjectOverview.tsx next to
// `selectedMemberUsername` for why and what widening it would take.

import { useEffect, useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ROLE } from "@/lib/frontier/roles"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { FLOOR_LABEL } from "@/pages/settings/constants"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchVisibilityOverrideCounts, type VisibilityOverrideCounts } from "@/lib/sync/org-settings"
import { OverrideStatus } from "./OverrideStatus"

interface RosterProgressSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the OWNER-only write gate. */
  canEdit: boolean
  /** The org these settings belong to — for the "N projects are stricter" counts. */
  orgId?: number | null
}

/**
 * AQU-1771: how many projects make each floor stricter than the org does.
 * Re-read whenever either floor moves, since that changes which projects are
 * stricter. Null until known (or on a server without the count).
 */
function useStricterProjectCounts(
  orgId: number | null | undefined,
  rosterFloor: number,
  progressFloor: number,
): VisibilityOverrideCounts | null {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [counts, setCounts] = useState<{ key: string; value: VisibilityOverrideCounts | null } | null>(null)
  const key = `${orgId ?? ""}:${rosterFloor}:${progressFloor}`
  useEffect(() => {
    if (!jwt || orgId == null) return
    let cancelled = false
    void fetchVisibilityOverrideCounts(jwt, orgId).then((value) => {
      if (!cancelled) setCounts({ key, value })
    })
    return () => { cancelled = true }
  }, [jwt, orgId, key])
  return counts?.key === key ? counts.value : null
}

// The closed-trigger text comes from FLOOR_LABEL (short); labelKey is the
// fuller sentence shown in the open dropdown list — see FloorSelect below.
const ROSTER_PROGRESS_ROLE_OPTIONS: { level: number; labelKey: MessageKey }[] = [
  { level: ROLE.VIEWER, labelKey: "settings.rosterProgress.optionViewer" },
  { level: ROLE.CONTRIBUTOR, labelKey: "settings.rosterProgress.optionContributor" },
  { level: ROLE.PROJECT_LEAD, labelKey: "settings.rosterProgress.optionProjectLead" },
  { level: ROLE.MAINTAINER, labelKey: "settings.rosterProgress.optionMaintainer" },
  { level: ROLE.OWNER, labelKey: "settings.rosterProgress.optionOwner" },
]

export function RosterProgressSection({ orgSettings, canEdit, orgId }: RosterProgressSectionProps) {
  const { t } = useI18n()
  const { rosterViewMinRole, memberProgressViewMinRole, patch } = orgSettings
  // AQU-1771: a project may make either floor stricter, never looser. Each
  // row says how many did, like the other org defaults. No reset link: a
  // project that hides more than the org asked for chose to, and putting it
  // back is that project's call.
  const stricter = useStricterProjectCounts(orgId, rosterViewMinRole, memberProgressViewMinRole)

  const [rosterBusy, setRosterBusy] = useState(false)
  const [rosterError, setRosterError] = useState<string | null>(null)
  const [progressBusy, setProgressBusy] = useState(false)
  const [progressError, setProgressError] = useState<string | null>(null)

  async function handleRosterChange(newLevel: number) {
    setRosterBusy(true)
    setRosterError(null)
    const result = await patch({ rosterViewMinRole: newLevel })
    if (result.kind === "error") {
      setRosterError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setRosterError("Only org owners can change the roster visibility policy.")
    }
    setRosterBusy(false)
  }

  async function handleProgressChange(newLevel: number) {
    setProgressBusy(true)
    setProgressError(null)
    const result = await patch({ memberProgressViewMinRole: newLevel })
    if (result.kind === "error") {
      setProgressError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setProgressError("Only org owners can change the member-progress visibility policy.")
    }
    setProgressBusy(false)
  }

  return (
    <SettingsGroup
      label={t("settings.rosterProgress.groupLabel")}
      description={t("settings.rosterProgress.groupDescription")}
    >
      <SettingsRow
        label={t("settings.rosterProgress.rosterLabel")}
        description={
          <>
            {t("settings.rosterProgress.rosterDescription")}
            {orgId != null && (
              <OverrideStatus
                count={stricter?.rosterViewMinRole ?? 0}
                kind="stricter"
                loading={stricter == null}
              />
            )}
          </>
        }
        control={
          <FloorSelect
            id="roster-min-role"
            ariaLabel={t("settings.rosterProgress.rosterLabel")}
            value={rosterViewMinRole}
            disabled={!canEdit || rosterBusy}
            error={rosterError}
            onChange={handleRosterChange}
          />
        }
      />
      <SettingsRow
        label={t("settings.rosterProgress.progressLabel")}
        description={
          <>
            {t("settings.rosterProgress.progressDescription")}
            {orgId != null && (
              <OverrideStatus
                count={stricter?.memberProgressViewMinRole ?? 0}
                kind="stricter"
                loading={stricter == null}
              />
            )}
          </>
        }
        control={
          <FloorSelect
            id="progress-min-role"
            ariaLabel={t("settings.rosterProgress.progressLabel")}
            value={memberProgressViewMinRole}
            disabled={!canEdit || progressBusy}
            error={progressError}
            onChange={handleProgressChange}
          />
        }
      />
    </SettingsGroup>
  )
}

function FloorSelect({
  id,
  ariaLabel,
  value,
  disabled,
  error,
  onChange,
}: {
  id: string
  ariaLabel: string
  value: number
  disabled: boolean
  error: string | null
  onChange: (level: number) => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex min-w-44 flex-col items-end gap-1">
      <Select
        items={ROSTER_PROGRESS_ROLE_OPTIONS.map((opt) => ({
          value: String(opt.level),
          label: FLOOR_LABEL[opt.level] ?? t(opt.labelKey),
        }))}
        value={String(value)}
        onValueChange={(v) => { if (v) onChange(Number(v)) }}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-label={ariaLabel} className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {ROSTER_PROGRESS_ROLE_OPTIONS.map((opt) => (
              <SelectItem key={opt.level} value={String(opt.level)}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error && <FieldError className="text-xs">{error}</FieldError>}
    </div>
  )
}
