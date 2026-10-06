// Org-wide switch: may bulk text validation sign off untouched AI drafts?
// (Sam, 2026-10-01.)
//
// Same boolean SettingsRow + Switch shape as RepetitionPropagationSection
// beside it, and the same MAINTAINER write gate: this widens what one validate
// gesture covers, not who may validate.
//
// Default OFF. An AI draft nobody has edited is reviewed one cell at a time
// (`isBulkValidationEligible`); an org whose reviewers read the drafts in place
// and sign a passage off at once opts in. Org-only — there is no project
// override, because the rule is about how the organization reviews AI work.

import { useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

interface BulkValidateAiDraftsSectionProps {
  orgSettings: UseOrgSettings
  /** True when the caller's org role meets the MAINTAINER write gate. */
  canEdit: boolean
}

export function BulkValidateAiDraftsSection({
  orgSettings,
  canEdit,
}: BulkValidateAiDraftsSectionProps) {
  const { t } = useI18n()
  const { allowBulkValidateAiDrafts, patch } = orgSettings

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(next: boolean) {
    setBusy(true)
    setError(null)
    const result = await patch({ allowBulkValidateAiDrafts: next })
    if (result.kind === "error") {
      setError(result.message ?? t("settings.bulkValidateAiDrafts.saveFailed"))
    } else if (result.kind === "blocked") {
      setError(t("settings.bulkValidateAiDrafts.blocked"))
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={t("settings.bulkValidateAiDrafts.label")}
      description={t("settings.bulkValidateAiDrafts.description")}
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Switch
            id="bulk-validate-ai-drafts"
            checked={allowBulkValidateAiDrafts}
            onCheckedChange={(checked) => void handleChange(checked)}
            disabled={!canEdit || busy}
            aria-label={t("settings.bulkValidateAiDrafts.label")}
          />
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
