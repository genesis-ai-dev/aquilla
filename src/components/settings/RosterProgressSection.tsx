// AQU-485: org-level roster + member-progress visibility controls.
//
// Two independent, configurable read-permission floors, generalizing the
// AQU-253 exportMinRole pattern:
//   - rosterViewMinRole:        who can see the member list + count
//   - memberProgressViewMinRole: who can see per-member progress/productivity
//
// Both default to Maintainer when unset — safe for sensitive teams that
// don't want to reveal who/how many are on a project, or what each person
// did, even to their own members. Displayed inside the org Settings page
// (/settings/roster). Editable only by org owners — stricter than the
// general MAINTAINER settings-write gate, mirroring exportMinRole's
// EXPORT_FLOOR_WRITE_MIN_ROLE (auth-worker/src/routes/org-settings.ts).
//
// AQU-498: consumed by ProjectOverview's Team card (per-teammate "Activity"
// affordance -> MemberActivityPanel), which lives inside the same
// SectionVisibilityGate this section's memberProgressViewMinRole feeds.
// SWARM-TODO(AQU-498): that view's member-selection list is currently scoped
// to assignees with open assignments (the Team card's existing roster), not
// every project member — see the SWARM-TODO in ProjectOverview.tsx next to
// `selectedMemberUsername` for why and what widening it would take.

import { useEffect, useState } from "react"
import { Check } from "lucide-react"
import { FieldDescription, FieldError } from "@/components/ui/field"
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
  const [rosterSaved, setRosterSaved] = useState(false)
  const [progressBusy, setProgressBusy] = useState(false)
  const [progressError, setProgressError] = useState<string | null>(null)
  const [progressSaved, setProgressSaved] = useState(false)

  useEffect(() => {
    if (!rosterSaved) return
    const t = setTimeout(() => setRosterSaved(false), 2500)
    return () => clearTimeout(t)
  }, [rosterSaved])

  useEffect(() => {
    if (!progressSaved) return
    const t = setTimeout(() => setProgressSaved(false), 2500)
    return () => clearTimeout(t)
  }, [progressSaved])

  async function handleRosterChange(newLevel: number) {
    setRosterBusy(true)
    setRosterError(null)
    setRosterSaved(false)
    const result = await patch({ rosterViewMinRole: newLevel })
    if (result.kind === "error") {
      setRosterError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setRosterError("Only org owners can change the roster visibility policy.")
    } else {
      setRosterSaved(true)
    }
    setRosterBusy(false)
  }

  async function handleProgressChange(newLevel: number) {
    setProgressBusy(true)
    setProgressError(null)
    setProgressSaved(false)
    const result = await patch({ memberProgressViewMinRole: newLevel })
    if (result.kind === "error") {
      setProgressError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setProgressError("Only org owners can change the member-progress visibility policy.")
    } else {
      setProgressSaved(true)
    }
    setProgressBusy(false)
  }

  return (
    <div className="space-y-6">
      <SettingsGroup label="Member roster">
        <SettingsRow
          label="Who can view the roster"
          description="Minimum role required to see the member list and member count, on both the org Members page and each project's Members tab. Defaults to Maintainer. Below this role, the roster and count are hidden entirely — not shown empty, just absent."
          block
        >
          <Select
            items={ROSTER_PROGRESS_ROLE_OPTIONS.map((opt) => ({ value: String(opt.level), label: opt.label }))}
            value={String(rosterViewMinRole)}
            onValueChange={(v) => { if (v) void handleRosterChange(Number(v)) }}
            disabled={!canEdit || rosterBusy}
          >
            <SelectTrigger id="roster-min-role" aria-label="Who can view the roster" className="w-full max-w-sm">
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
          {!canEdit && (
            <FieldDescription>Only org owners can change the roster visibility policy.</FieldDescription>
          )}
          {rosterError && (
            <FieldError className="text-xs">{rosterError}</FieldError>
          )}
          {rosterSaved && (
            <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400" role="status" data-testid="roster-role-saved">
              <Check className="size-3.5" /> Saved
            </p>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="Member progress">
        <SettingsRow
          label="Who can view member progress"
          description="Minimum role required to see per-member progress/productivity — separate from roster visibility. Defaults to Maintainer. Independent of roster visibility — a role can see who's on the team without seeing their progress, or vice versa."
          block
        >
          <Select
            items={ROSTER_PROGRESS_ROLE_OPTIONS.map((opt) => ({ value: String(opt.level), label: opt.label }))}
            value={String(memberProgressViewMinRole)}
            onValueChange={(v) => { if (v) void handleProgressChange(Number(v)) }}
            disabled={!canEdit || progressBusy}
          >
            <SelectTrigger id="progress-min-role" aria-label="Who can view member progress" className="w-full max-w-sm">
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
          {!canEdit && (
            <FieldDescription>Only org owners can change the member-progress visibility policy.</FieldDescription>
          )}
          {progressError && (
            <FieldError className="text-xs">{progressError}</FieldError>
          )}
          {progressSaved && (
            <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400" role="status" data-testid="progress-role-saved">
              <Check className="size-3.5" /> Saved
            </p>
          )}
        </SettingsRow>
      </SettingsGroup>
    </div>
  )
}
