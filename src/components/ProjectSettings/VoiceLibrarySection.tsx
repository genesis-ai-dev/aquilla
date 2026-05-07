// Project-level voice settings: engine choice + API key. The voice library
// (preset + user voices, prompts, accents, pronunciation) is edited from a
// per-cell modal, not here — this card only owns what's truly project-wide.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { ApiKeyField } from "@/components/ApiKeyField"
import type { ProjectTtsSettings, TtsProvider } from "@/lib/parsers/types"
import { DEFAULT_TTS_PROVIDER, TTS_PROVIDER_INFOS } from "@/lib/audio/tts-providers"
import { HAS_HOSTED_MMS_MODELS, USE_SHERPA_MMS_MODELS } from "@/lib/audio/mms-languages"
import { setUserApiKey, useUserApiKey } from "@/lib/store/user-api-keys"

interface Props {
  settings: ProjectTtsSettings | undefined
  onChange: (next: Partial<ProjectTtsSettings>) => void | Promise<void>
}

export function VoiceLibrarySection({ settings, onChange }: Props) {
  const provider: TtsProvider = settings?.provider ?? DEFAULT_TTS_PROVIDER
  const projectKey = settings?.apiKey ?? ""
  const userKey = useUserApiKey("gemini-tts") ?? ""

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice engine</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3">
          {TTS_PROVIDER_INFOS.map((info) => (
            <ProviderTile
              key={info.id}
              active={provider === info.id}
              title={info.title}
              badge={info.badge}
              hint={info.hint}
              onClick={() => onChange({ provider: info.id })}
            />
          ))}
        </div>

        {provider === "gemini" && (
          <ApiKeyField
            label="Gemini API key"
            placeholder="AIza..."
            projectKey={projectKey}
            userKey={userKey}
            onProjectKeyChange={(v) => onChange({ apiKey: v || undefined })}
            onUserKeyChange={(v) => setUserApiKey("gemini-tts", v)}
            help="Sent directly to Google. Never uploaded to Frontier."
          />
        )}

        {provider === "mms" && (
          <p className="text-xs text-muted-foreground">
            No API key. Each MMS voice is tied to one language code.
            {USE_SHERPA_MMS_MODELS
              ? " MMS codes are loaded from the public Sherpa-ONNX mirror."
              : HAS_HOSTED_MMS_MODELS
              ? " Hosted MMS codes are loaded from the configured model bucket."
              : " The public browser set is limited; pick one of the listed languages in the voice editor."}
          </p>
        )}

        {provider === "kokoro" && (
          <p className="text-xs text-muted-foreground">
            No API key needed. Pick voices from the per-cell voice picker.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

interface ProviderTileProps {
  active: boolean
  title: string
  hint: string
  badge?: string
  onClick: () => void
}

function ProviderTile({ active, title, hint, badge, onClick }: ProviderTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-lg border p-3 text-left transition-colors",
        active ? "border-primary bg-primary/5" : "hover:bg-accent/40",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <span>{title}</span>
        {badge && (
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
            {badge}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </button>
  )
}
