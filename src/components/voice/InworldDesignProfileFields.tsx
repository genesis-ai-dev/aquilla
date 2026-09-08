// Inworld Voice Design — Structured tab. One input per profile attribute;
// serializeInworldVoiceProfile turns these into the verbatim designPrompt.

import { ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  INWORLD_DESIGN_PROFILE_KEYS,
  INWORLD_VOICE_DESIGN_DOCS_URL,
  type InworldDesignProfileKey,
  type InworldVoiceProfile,
} from "@/lib/audio/inworld-voice-design"

const ATTR_LABEL_KEYS = {
  dialect: "audio.newVoice.designAttrDialect",
  gender: "audio.newVoice.designAttrGender",
  age: "audio.newVoice.designAttrAge",
  emotion: "audio.newVoice.designAttrEmotion",
  tone: "audio.newVoice.designAttrTone",
  pitch: "audio.newVoice.designAttrPitch",
  volume: "audio.newVoice.designAttrVolume",
  speed: "audio.newVoice.designAttrSpeed",
  clarity: "audio.newVoice.designAttrClarity",
  fluency: "audio.newVoice.designAttrFluency",
  personality: "audio.newVoice.designAttrPersonality",
  texture: "audio.newVoice.designAttrTexture",
  environment: "audio.newVoice.designAttrEnvironment",
} as const

export function InworldDesignProfileFields({
  profile,
  onChange,
  onClear,
}: {
  profile: InworldVoiceProfile
  onChange: (key: InworldDesignProfileKey, value: string) => void
  onClear: () => void
}) {
  const t = useT()

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {t("audio.newVoice.designStructuredHint")}{" "}
          <a
            href={INWORLD_VOICE_DESIGN_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
          >
            {t("audio.newVoice.designDocsLink")}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2 text-[11px]"
          onClick={onClear}
        >
          {t("audio.newVoice.designClearProfile")}
        </Button>
      </div>
      <div className="space-y-1.5">
        {INWORLD_DESIGN_PROFILE_KEYS.map((key) => {
          const id = `inworld-design-${key}`
          return (
            <div key={key} className="grid grid-cols-[6.75rem_minmax(0,1fr)] items-center gap-2">
              <label
                htmlFor={id}
                className="truncate text-sm leading-none text-muted-foreground"
              >
                {t(ATTR_LABEL_KEYS[key])}
              </label>
              <Input
                id={id}
                value={profile[key]}
                onChange={(event) => onChange(key, event.target.value)}
                className="h-8"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
