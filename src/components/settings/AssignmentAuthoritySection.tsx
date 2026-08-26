// AQU-496 / AQU-581: org-level assignment-authority controls.
//
// Generalizes the AQU-485 permission-policy pattern (RosterProgressSection,
// exportMinRole) to booleans. Two rows, both answering "who may write
// `assignment.create` below the project_lead floor":
//
//   allowSelfAssignment (AQU-496)       — members may claim work for
//     THEMSELVES (never for anyone else).
//   allowScopedLaneAssignment (AQU-581) — a member the org restricted to
//     particular target-language lanes may assign work to OTHER people inside
//     those lanes. The setting alone grants nothing: without lane scopes on
//     the member (Members → language restrictions) it is inert, which is what
//     makes it a per-lane delegation rather than a blanket one.
//
// Leads/maintainers can always assign regardless of either.
//
// Editable only by org owners (OWNER-only write gate — see
// EXPORT_FLOOR_WRITE_MIN_ROLE / ASSIGNMENT_AUTHORITY_WRITE_MIN_ROLE), same
// rationale as the other permission-policy keys: a maintainer must not be
// able to unilaterally loosen who can assign work. Enforced server-side in
// sync-worker (authorize.ts self-assign + lane-delegate carve-outs); this UI
// is the affordance only.

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

/** One boolean assignment-policy switch, with its own busy/error state. */
function PolicySwitch({
  id,
  label,
  description,
  checked,
  canEdit,
  onSave,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  canEdit: boolean
  onSave: (next: boolean) => Promise<{ kind: string; message?: string }>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(next: boolean) {
    setBusy(true)
    setError(null)
    const result = await onSave(next)
    if (result.kind === "error") {
      setError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setError("Only org owners can change the assignment authority policy.")
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={label}
      description={description}
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Switch
            id={id}
            checked={checked}
            onCheckedChange={(next) => void handleChange(next)}
            disabled={!canEdit || busy}
            aria-label={label}
          />
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}

export function AssignmentAuthoritySection({ orgSettings, canEdit }: AssignmentAuthoritySectionProps) {
  const { t } = useI18n()
  const { allowSelfAssignment, allowScopedLaneAssignment, patch } = orgSettings

  return (
    <>
      <PolicySwitch
        id="allow-self-assignment"
        label={t("settings.assignmentAuthority.label")}
        description={t("settings.assignmentAuthority.description")}
        checked={allowSelfAssignment}
        canEdit={canEdit}
        onSave={(next) => patch({ allowSelfAssignment: next })}
      />
      <PolicySwitch
        id="allow-scoped-lane-assignment"
        label={t("settings.laneAssignmentAuthority.label")}
        description={t("settings.laneAssignmentAuthority.description")}
        checked={allowScopedLaneAssignment}
        canEdit={canEdit}
        onSave={(next) => patch({ allowScopedLaneAssignment: next })}
      />
    </>
  )
}
