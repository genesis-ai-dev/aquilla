// AQU-822: org-level "who can manage terminology" control.
//
// Same permission-policy pattern as RosterProgressSection (rosterViewMinRole,
// memberProgressViewMinRole) and exportMinRole, with two differences worth
// knowing before you touch it:
//
//   1. It gates a WRITE, not a read. Below the floor the termbase renders
//      read-only; at or above it the user gets FULL management — add, edit,
//      delete, archive. There is deliberately no draft/suggestion/approval
//      layer (decided 2026-08-07 with BGP).
//   2. Its default is Project lead (500), not Maintainer — 500 is the level
//      the terminology UI has always shown the editor at.
//
// Editable only by org owners (OWNER-only write gate, enforced server-side in
// auth-worker/src/routes/org-settings.ts): a maintainer must not be able to
// hand out termbase management on their own authority. Lowering the floor
// affects terminology ONLY — every other project setting stays maintainer-
// gated (see the terminology-scoped carve-out in project-settings.ts).

import { useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
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
import { FLOOR_LABEL } from "@/pages/settings/constants"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface TermbaseEditSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the OWNER-only write gate. */
  canEdit: boolean
}

const TERMBASE_ROLE_OPTIONS = [
  { level: ROLE.CONTRIBUTOR, label: "Contributor (400) — translators manage terms" },
  { level: ROLE.PROJECT_LEAD, label: "Project lead (500) — default" },
  { level: ROLE.MAINTAINER, label: "Maintainer (600) — most restrictive" },
]

export function TermbaseEditSection({ orgSettings, canEdit }: TermbaseEditSectionProps) {
  const { t } = useI18n()
  const { termbaseEditMinRole, patch } = orgSettings

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(newLevel: number) {
    setBusy(true)
    setError(null)
    const result = await patch({ termbaseEditMinRole: newLevel })
    if (result.kind === "error") {
      setError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setError("Only org owners can change the terminology permission policy.")
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={t("settings.termbase.label")}
      description={t("settings.termbase.description")}
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Select
            items={TERMBASE_ROLE_OPTIONS.map((opt) => ({
              value: String(opt.level),
              label: FLOOR_LABEL[opt.level] ?? opt.label,
            }))}
            value={String(termbaseEditMinRole)}
            onValueChange={(v) => { if (v) void handleChange(Number(v)) }}
            disabled={!canEdit || busy}
          >
            <SelectTrigger id="termbase-min-role" aria-label={t("settings.termbase.label")} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {TERMBASE_ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.level} value={String(opt.level)}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
