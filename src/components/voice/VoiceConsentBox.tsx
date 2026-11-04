// The organization's consent confirmation for making an AI model of a real
// person's voice. Shared by Train voice (TrainVoicePanel) and ElevenLabs
// cloning (ElevenLabsClonePanel, AQU-2299): one statement, one wording, one
// audit record shape. Nothing that uses it may start until it is ticked.
import { ShieldCheck } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Checkbox } from "@/components/ui/checkbox"
import { CUSTOM_VOICE_CONSENT_STATEMENT } from "@/lib/audio/custom-voice"

export function VoiceConsentBox({
  id,
  checked,
  onCheckedChange,
}: {
  /** Unique per surface so the label's htmlFor finds its own checkbox. */
  id: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const t = useT()
  return (
    <div className="space-y-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
      <p className="flex items-center gap-1.5 text-[13px] font-medium">
        <ShieldCheck className="size-4 text-amber-600 dark:text-amber-400" />
        {t("audio.train.consentTitle")}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("audio.train.consentBody")}</p>
      <details className="group text-[11px] text-muted-foreground">
        <summary className="cursor-pointer select-none underline-offset-2 hover:underline">
          {t("audio.train.fullStatement")}
        </summary>
        <p className="mt-1.5 rounded-md bg-background/60 p-2 leading-relaxed" lang="en">{CUSTOM_VOICE_CONSENT_STATEMENT}</p>
      </details>
      {/* Not a wrapping <label>: around the Checkbox's own button, one click
          would toggle it twice. */}
      <div className="flex items-start gap-2 text-xs">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(v) => onCheckedChange(v === true)}
          aria-label={t("audio.train.consentCheckboxAriaLabel")}
          className="mt-0.5"
        />
        <label htmlFor={id} className="leading-relaxed">{t("audio.train.consentCheckbox")}</label>
      </div>
    </div>
  )
}
