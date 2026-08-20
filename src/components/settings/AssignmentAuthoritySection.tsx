// AQU-496: org-level "who can self-assign" control.
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

import { useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface AssignmentAuthoritySectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the OWNER-only write gate. */
  canEdit: boolean
}

export function AssignmentAuthoritySection({ orgSettings, canEdit }: AssignmentAuthoritySectionProps) {
  const { t } = useI18n()
  const { allowSelfAssignment, patch } = orgSettings

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(next: boolean) {
    setBusy(true)
    setError(null)
    const result = await patch({ allowSelfAssignment: next })
    if (result.kind === "error") {
      setError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setError("Only org owners can change the assignment authority policy.")
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={t("settings.assignmentAuthority.label")}
      description={t("settings.assignmentAuthority.description")}
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Switch
            id="allow-self-assignment"
            checked={allowSelfAssignment}
            onCheckedChange={(checked) => void handleChange(checked)}
            disabled={!canEdit || busy}
            aria-label={t("settings.assignmentAuthority.label")}
          />
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
