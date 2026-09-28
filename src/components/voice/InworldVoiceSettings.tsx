// Inworld playground knobs on a voice: audio quality, delivery, talking speed.
// Highest quality switches the request to inworld-tts-2 so Delivery and steering
// are honored.

import { ExternalLink, RotateCcw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { VoiceInfoTip } from "@/components/voice/VoiceInfoTip"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  DEFAULT_INWORLD_DELIVERY_MODE,
  INWORLD_SPEAKING_RATE_DEFAULT,
  INWORLD_SPEAKING_RATE_MAX,
  INWORLD_SPEAKING_RATE_MIN,
  INWORLD_SPEAKING_RATE_STEP,
  INWORLD_STEERING_DOCS_URL,
  effectiveInworldAudioQuality,
  effectiveInworldDeliveryMode,
  effectiveInworldSpeakingRate,
  formatInworldSpeakingRate,
  inworldDeliveryIndex,
  inworldDeliveryModeAt,
  type InworldAudioQuality,
  type InworldDeliveryMode,
} from "@/lib/audio/inworld-voice-settings"
import type { Voice } from "@/lib/parsers/types"

export function InworldVoiceSettings({
  voice,
  onChange,
  previewIgnored = false,
}: {
  voice: Pick<Voice, "speakingRate" | "deliveryMode" | "audioQuality">
  onChange: (patch: Pick<Voice, "speakingRate" | "deliveryMode" | "audioQuality">) => void
  /** Voice Design samples do not send these knobs; they apply on later synthesize. */
  previewIgnored?: boolean
}) {
  const t = useT()
  const quality = effectiveInworldAudioQuality(voice)
  const delivery = effectiveInworldDeliveryMode(voice)
  const rate = effectiveInworldSpeakingRate(voice)
  const highest = quality === "highest"

  const setQuality = (next: InworldAudioQuality) => {
    onChange({
      audioQuality: next,
      ...(next === "highest" && !voice.deliveryMode ? { deliveryMode: DEFAULT_INWORLD_DELIVERY_MODE } : {}),
    })
  }

  const setDelivery = (next: InworldDeliveryMode) => {
    onChange({ deliveryMode: next })
  }

  const setRate = (next: number) => {
    onChange({ speakingRate: next })
  }

  return (
    <div className="space-y-4">
      {previewIgnored && (
        <p className="text-[11px] text-muted-foreground">{t("audio.newVoice.designKnobsHint")}</p>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-sm font-medium">{t("audio.newVoice.audioQualityLabel")}</span>
          <VoiceInfoTip
            label={t("audio.newVoice.audioQualityHelpAria")}
            content={t("audio.newVoice.audioQualityHint")}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 text-end text-sm text-muted-foreground">
            {highest ? t("audio.newVoice.audioQualityHighest") : t("audio.newVoice.audioQualityStandard")}
          </span>
          <Switch
            size="sm"
            checked={highest}
            onCheckedChange={(checked) => setQuality(checked === true ? "highest" : "standard")}
            aria-label={t("audio.newVoice.audioQualityLabel")}
          />
        </div>
      </div>

      <div className={highest ? "space-y-2" : "space-y-2 opacity-50"}>
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{t("audio.newVoice.deliveryLabel")}</span>
          <VoiceInfoTip
            label={t("audio.newVoice.deliveryHelpAria")}
            content={highest ? t("audio.newVoice.deliveryHint") : t("audio.newVoice.deliveryNeedsHighest")}
          />
        </div>
        <Slider
          min={0}
          max={2}
          step={1}
          value={[inworldDeliveryIndex(delivery)]}
          disabled={!highest}
          onValueChange={(next) => {
            const idx = Array.isArray(next) ? next[0] : next
            setDelivery(inworldDeliveryModeAt(typeof idx === "number" ? idx : 0))
          }}
          aria-label={t("audio.newVoice.deliveryLabel")}
        />
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{t("audio.newVoice.deliveryStable")}</span>
          <span>{t("audio.newVoice.deliveryBalanced")}</span>
          <span>{t("audio.newVoice.deliveryCreative")}</span>
        </div>
        {highest && (
          <a
            href={INWORLD_STEERING_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {t("audio.newVoice.steeringBestPractices")}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">{t("audio.newVoice.talkingSpeedLabel")}</span>
            <VoiceInfoTip
              label={t("audio.newVoice.talkingSpeedHelpAria")}
              content={t("audio.newVoice.talkingSpeedHint")}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={rate === INWORLD_SPEAKING_RATE_DEFAULT}
              onClick={() => setRate(INWORLD_SPEAKING_RATE_DEFAULT)}
              aria-label={t("audio.newVoice.talkingSpeedResetAria")}
            >
              <RotateCcw />
            </Button>
            <Badge variant="outline" className="bg-muted tabular-nums">
              {formatInworldSpeakingRate(rate)}
            </Badge>
          </div>
        </div>
        <Slider
          min={INWORLD_SPEAKING_RATE_MIN}
          max={INWORLD_SPEAKING_RATE_MAX}
          step={INWORLD_SPEAKING_RATE_STEP}
          value={[rate]}
          onValueChange={(next) => {
            const value = Array.isArray(next) ? next[0] : next
            if (typeof value === "number") setRate(value)
          }}
          aria-label={t("audio.newVoice.talkingSpeedLabel")}
        />
        <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>{INWORLD_SPEAKING_RATE_MIN}</span>
          <span>{INWORLD_SPEAKING_RATE_DEFAULT.toFixed(1)}</span>
          <span>{INWORLD_SPEAKING_RATE_MAX}</span>
        </div>
      </div>
    </div>
  )
}
