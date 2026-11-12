// Omnilingual ASR: may this org's members use the zero-shot model? Default
// ON — each member still has to choose it in Preferences — and an org admin
// (the hook's MAINTAINER write gate) can turn it off for everyone.

import { useState } from "react"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

export function ZeroShotTranscriptionSection({ orgSettings }: { orgSettings: UseOrgSettings }) {
  const { t } = useI18n()
  const { settings, patch, canEdit } = orgSettings
  const enabled = settings.transcription?.zeroShotEnabled !== false

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(next: boolean) {
    setBusy(true)
    setError(null)
    // `patch` replaces top-level keys, so keep the rest of `transcription`.
    const result = await patch({ transcription: { ...settings.transcription, zeroShotEnabled: next } })
    if (result.kind === "error") {
      setError(result.message ?? t("settings.transcription.zeroShot.orgSaveFailed"))
    } else if (result.kind === "blocked" || result.kind === "forbidden") {
      setError(t("settings.transcription.zeroShot.orgBlocked"))
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={t("settings.transcription.zeroShot.orgLabel")}
      description={t("settings.transcription.zeroShot.orgDescription")}
      control={
        <div className="flex min-w-44 flex-col items-end gap-1">
          <Switch
            id="allow-zero-shot-transcription"
            checked={enabled}
            onCheckedChange={(checked) => void handleChange(checked)}
            disabled={!canEdit || busy}
            aria-label={t("settings.transcription.zeroShot.orgLabel")}
          />
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
