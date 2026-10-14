// AQU-1954: "This project records audio" — whether every book of this project
// needs audio, or only the files somebody has already recorded in.
//
// Off (the default, and what the plan board has always done), a file counts
// audio once it has a take or a cue sheet; on, every file does from day one.
// The plan board, its export and the project's audio numbers all follow it.
//
// It patches the shared settings blob DIRECTLY, like the headings row beside
// it and for the same reason (see StructuralCellsProjectSection): this page's
// draft/baseline state seeds from the project without the settings overlay.

import { useState } from "react"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { FieldError } from "@/components/ui/field"
import { SettingsRow } from "@/components/ui/page"
import { Switch } from "@/components/ui/switch"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ReactNode } from "react"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"

interface Props {
  /** The stored switch. Absent reads as off. */
  value: boolean | undefined
  disabled?: boolean
  disabledTooltip?: ReactNode
  /** Patches the shared settings blob. */
  onPatch: (updates: ProjectWideSettings) => Promise<{ kind: string; message?: string }>
}

export function RecordsAudioProjectSection({ value, disabled, disabledTooltip, onPatch }: Props) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(next: boolean) {
    setBusy(true)
    setError(null)
    const result = await onPatch({ recordsAudio: next })
    if (result.kind === "error" || result.kind === "blocked") {
      setError(result.message ?? t("projectSettings.recordsAudio.saveFailed"))
    }
    setBusy(false)
  }

  return (
    <SettingsRow
      label={<label htmlFor="records-audio">{t("projectSettings.recordsAudio.label")}</label>}
      description={t("projectSettings.recordsAudio.description")}
      control={
        <div className="flex flex-col items-end gap-1">
          <DisabledFieldTooltip disabled={Boolean(disabled)} tooltip={disabledTooltip ?? null}>
            <Switch
              id="records-audio"
              data-testid="settings-records-audio"
              checked={value === true}
              disabled={disabled || busy}
              onCheckedChange={(checked) => void handleChange(checked)}
              aria-label={t("projectSettings.recordsAudio.label")}
            />
          </DisabledFieldTooltip>
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>
      }
    />
  )
}
