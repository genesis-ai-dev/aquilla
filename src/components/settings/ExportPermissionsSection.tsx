// AQU-253: org-level "who can export deliverables" floor.
// Same OWNER-only write gate as roster/progress/assignment/termbase.

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
import { FLOOR_LABEL } from "@/pages/settings/constants"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface ExportPermissionsSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the OWNER-only write gate. */
  canEdit: boolean
}

const EXPORT_ROLE_OPTIONS = [
  { level: ROLE.VIEWER, label: "Viewer (100) — anyone with project access" },
  { level: ROLE.CONTRIBUTOR, label: "Contributor (400)" },
  { level: ROLE.PROJECT_LEAD, label: "Project lead (500)" },
  { level: ROLE.MAINTAINER, label: "Maintainer (600) — default" },
  { level: ROLE.OWNER, label: "Owner (700) — most restrictive" },
]

export function ExportPermissionsSection({ orgSettings, canEdit }: ExportPermissionsSectionProps) {
  const { exportMinRole, patch } = orgSettings
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const displayed = exportMinRole ?? ROLE.MAINTAINER

  async function handleChange(newLevel: number) {
    setBusy(true)
    setError(null)
    const result = await patch({ exportMinRole: newLevel })
    if (result.kind === "error") {
      setError(result.message ?? "Save failed")
    } else if (result.kind === "blocked") {
      setError("Only org owners can change the export permission policy.")
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label="Who can export"
      description="Minimum role required to download project deliverables — USFM export and project zip. Client-side formats (CSV, TSV) operate on already-loaded cells and can't be enforced here."
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Select
            items={EXPORT_ROLE_OPTIONS.map((opt) => ({
              value: String(opt.level),
              label: FLOOR_LABEL[opt.level] ?? opt.label,
            }))}
            value={String(displayed)}
            onValueChange={(v) => { if (v) void handleChange(Number(v)) }}
            disabled={!canEdit || busy}
          >
            <SelectTrigger id="export-min-role" aria-label="Who can export" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {EXPORT_ROLE_OPTIONS.map((opt) => (
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
