// AQU-496 / AQU-581: org-level assignment-authority controls.
//
// Generalizes the AQU-485 permission-policy pattern (RosterProgressSection,
// exportMinRole) to a boolean setting: whether members below project_lead may
// claim `assignment.create` for THEMSELVES (never for anyone else). Default
// (unset) is OFF — leads/maintainers-only, the pre-AQU-496 behavior.
// Leads/maintainers can always assign regardless of this setting.
//
// Editable only by org owners (OWNER-only write gate — see
// EXPORT_FLOOR_WRITE_MIN_ROLE / ASSIGNMENT_AUTHORITY_WRITE_MIN_ROLE), same
// rationale as the other permission-policy keys: a maintainer must not be
// able to unilaterally loosen who can assign work. Enforced server-side in
// sync-worker (authorize.ts self-assign carve-out); this UI is the
// affordance only.
//
// AQU-581 adds a second boolean row on the same OWNER-only gate:
// allowScopedLaneAssignment — whether a member the org restricted to
// particular target-language lanes may assign work to OTHER people inside
// those lanes. The setting alone grants nothing: without lane scopes on the
// member (Members -> language restrictions) it is inert, which is what makes
// it a per-lane delegation rather than a blanket one.

import { useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { ALL_ROLE_LEVELS, resolveRoleName } from "@/lib/frontier/roles"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface AssignmentAuthoritySectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the OWNER-only write gate. */
  canEdit: boolean
}

export function AssignmentAuthoritySection({ orgSettings, canEdit }: AssignmentAuthoritySectionProps) {
  const { t } = useI18n()
  const { allowSelfAssignment, allowScopedLaneAssignment, assignmentMinRole, patch } = orgSettings

  const [busyKey, setBusyKey] = useState<"floor" | "self" | "lane" | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(partial: {
    assignmentMinRole?: number
    allowSelfAssignment?: boolean
    allowScopedLaneAssignment?: boolean
  }, key: "floor" | "self" | "lane") {
    setBusyKey(key)
    setError(null)
    const result = await patch(partial)
    if (result.kind === "error") {
      setError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setError("Only org owners can change the assignment authority policy.")
    }
    setBusyKey(null)
  }

  return (
    <>
      <SettingsRow
        label={t("settings.assignmentAuthority.floorLabel")}
        description={t("settings.assignmentAuthority.floorDescription")}
        control={
          <Select
            items={ALL_ROLE_LEVELS.map((level) => ({
              value: String(level),
              label: `${resolveRoleName(t, level)} (${level})`,
            }))}
            value={String(assignmentMinRole)}
            onValueChange={(value) => {
              if (value) void handleChange({ assignmentMinRole: Number(value) }, "floor")
            }}
            disabled={!canEdit || busyKey !== null}
          >
            <SelectTrigger
              id="assignment-min-role"
              aria-label={t("settings.assignmentAuthority.floorLabel")}
              className="w-44"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {ALL_ROLE_LEVELS.map((level) => (
                  <SelectItem key={level} value={String(level)}>
                    {resolveRoleName(t, level)} ({level})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label={t("settings.assignmentAuthority.label")}
        description={t("settings.assignmentAuthority.description")}
        control={
          <div className="flex min-w-44 flex-col items-end gap-1">
            <Switch
              id="allow-self-assignment"
              checked={allowSelfAssignment}
              onCheckedChange={(checked) => {
                void handleChange({ allowSelfAssignment: checked }, "self")
              }}
              disabled={!canEdit || busyKey !== null}
              aria-label={t("settings.assignmentAuthority.label")}
            />
            {error && <FieldError className="text-xs">{error}</FieldError>}
          </div>
        }
      />
      <SettingsRow
        label={t("settings.laneAssignmentAuthority.label")}
        description={t("settings.laneAssignmentAuthority.description")}
        control={
          <div className="flex min-w-44 flex-col items-end gap-1">
            <Switch
              id="allow-scoped-lane-assignment"
              checked={allowScopedLaneAssignment}
              onCheckedChange={(checked) => {
                void handleChange({ allowScopedLaneAssignment: checked }, "lane")
              }}
              disabled={!canEdit || busyKey !== null}
              aria-label={t("settings.laneAssignmentAuthority.label")}
            />
          </div>
        }
      />
    </>
  )
}
