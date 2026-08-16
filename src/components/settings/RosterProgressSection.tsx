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

import { useState } from "react"
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
import { FLOOR_LABEL } from "@/pages/settings/constants"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface RosterProgressSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the OWNER-only write gate. */
  canEdit: boolean
}

const ROSTER_PROGRESS_ROLE_OPTIONS = [
  { level: ROLE.VIEWER, label: "Viewer (100) — anyone with access" },
  { level: ROLE.CONTRIBUTOR, label: "Contributor (400)" },
  { level: ROLE.PROJECT_LEAD, label: "Project lead (500)" },
  { level: ROLE.MAINTAINER, label: "Maintainer (600) — default" },
  { level: ROLE.OWNER, label: "Owner (700) — most restrictive" },
]

export function RosterProgressSection({ orgSettings, canEdit }: RosterProgressSectionProps) {
  const { rosterViewMinRole, memberProgressViewMinRole, patch } = orgSettings

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
      label="Visibility"
      description="Who can see the member roster and per-member progress. Both default to Maintainer."
    >
      <SettingsRow
        label="Who can view the roster"
        description="Minimum role required to see the member list and member count, on both the org Members page and each project's Members tab. Below this role, the roster and count are hidden entirely — not shown empty, just absent."
        control={
          <FloorSelect
            id="roster-min-role"
            ariaLabel="Who can view the roster"
            value={rosterViewMinRole}
            disabled={!canEdit || rosterBusy}
            error={rosterError}
            onChange={handleRosterChange}
          />
        }
      />
      <SettingsRow
        label="Who can view member progress"
        description="Minimum role required to see per-member progress/productivity. Independent of roster visibility — a role can see who's on the team without seeing their progress, or vice versa."
        control={
          <FloorSelect
            id="progress-min-role"
            ariaLabel="Who can view member progress"
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
  return (
    <div className="flex min-w-44 flex-col items-end gap-1">
      <Select
        items={ROSTER_PROGRESS_ROLE_OPTIONS.map((opt) => ({
          value: String(opt.level),
          label: FLOOR_LABEL[opt.level] ?? opt.label,
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
                {opt.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error && <FieldError className="text-xs">{error}</FieldError>}
    </div>
  )
}
