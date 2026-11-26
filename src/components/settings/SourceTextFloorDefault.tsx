// AQU-2647: the organization's default for who may edit source text.
// Projects follow it unless they set their own. Maintainers may change it.

import { useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  SOURCE_TEXT_FLOOR_OPTIONS,
} from "@/components/ProjectSettings/cell-editing-floor-options"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { isSourceTextTier, type SourceTextTier } from "../../../db/shared/source-text-floor"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

export function SourceTextFloorDefault({
  orgSettings,
  canEdit,
}: {
  orgSettings: UseOrgSettings
  canEdit: boolean
}) {
  const { t } = useI18n()
  const stored = orgSettings.settings.sourceTextFloor
  const value: SourceTextTier = isSourceTextTier(stored) ? stored : "maintainer"
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose(next: SourceTextTier) {
    if (next === value) return
    setBusy(true)
    setError(null)
    const result = await orgSettings.patch({ sourceTextFloor: next })
    if (result.kind === "error") setError(result.message ?? t("settings.sourceText.saveFailed"))
    else if (result.kind === "blocked") setError(t("settings.sourceText.blocked"))
    setBusy(false)
  }

  return (
    <SettingsRow
      label={<label htmlFor="org-source-text-floor">{t("settings.sourceText.label")}</label>}
      description={t("settings.sourceText.description")}
      control={
        <div className="flex flex-col items-end gap-1">
          <Select
            items={SOURCE_TEXT_FLOOR_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
            disabled={!canEdit || busy}
            value={value}
            onValueChange={(next) => {
              if (isSourceTextTier(next)) void choose(next)
            }}
          >
            <SelectTrigger
              id="org-source-text-floor"
              data-testid="org-source-text-floor"
              aria-label={t("settings.sourceText.label")}
              className="w-80 bg-background"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {SOURCE_TEXT_FLOOR_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{t(option.labelKey)}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {error ? <FieldError>{error}</FieldError> : null}
        </div>
      }
    />
  )
}
