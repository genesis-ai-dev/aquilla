// Optional onboarding step: download the in-browser AI models in the
// background so transcription + TTS feel instant the first time the user
// triggers them. Setting the consent flag here also suppresses the per-
// feature consent dialog later in the session.

import { useEffect, useState } from "react"
import { CheckCircle2, Download, AlertCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { prefetchAiModels, useModelStatus } from "@/lib/audio/prefetch"
import { storeAllFeaturesConsent } from "@/lib/audio/ai-consent"
import { patchProject } from "@/lib/store/project-index"
import type { ProjectRecord, ProjectTtsSettings, TtsProvider } from "@/lib/parsers/types"
import { DEFAULT_MMS_LANGUAGE, DEFAULT_TTS_PROVIDER, TTS_PROVIDER_INFOS } from "@/lib/audio/tts-providers"

interface ModelRowProps {
  label: string
  sizeMb: number
  status: ReturnType<typeof useModelStatus>
}

function ModelRow({ label, sizeMb, status }: ModelRowProps) {
  const pct = status.kind === "downloading" && status.total > 0
    ? Math.round((status.loaded / status.total) * 100)
    : null
  const bar = status.kind === "downloading" && status.total > 0
    ? `${Math.round((status.loaded / status.total) * 100)}%`
    : status.kind === "downloading"
      ? "starting…"
      : null

  return (
    <div className="rounded border bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        {status.kind === "ready" ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        ) : status.kind === "error" ? (
          <AlertCircle className="h-3.5 w-3.5 text-destructive" />
        ) : status.kind === "downloading" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : (
          <Download className="h-3.5 w-3.5 text-muted-foreground/70" />
        )}
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">~{sizeMb} MB</span>
        <span className="ml-auto tabular-nums text-xs text-muted-foreground">
          {status.kind === "ready" && "Ready"}
          {status.kind === "downloading" && bar}
          {status.kind === "error" && "Failed"}
          {status.kind === "idle" && ""}
        </span>
      </div>
      {status.kind === "downloading" && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-150"
            style={{ width: `${pct ?? 8}%` }}
          />
        </div>
      )}
      {status.kind === "error" && (
        <p className="mt-1 text-xs text-destructive">{status.message}</p>
      )}
    </div>
  )
}

interface AiModelsStepProps {
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}

export function AiModelsStep({ project, onUpdated }: AiModelsStepProps) {
  const whisper = useModelStatus("whisper")
  const kokoro = useModelStatus("kokoro")
  const mms = useModelStatus("mms")
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>(
    project.ttsSettings?.provider ?? DEFAULT_TTS_PROVIDER,
  )
  const [geminiKey, setGeminiKey] = useState(project.ttsSettings?.apiKey ?? "")
  const [error, setError] = useState<string | null>(null)
  const ttsModelStatus = ttsProvider === "mms" ? mms : kokoro
  const allReady =
    whisper.kind === "ready" &&
    (ttsProvider === "gemini" ? Boolean(geminiKey.trim()) : ttsModelStatus.kind === "ready")
  const anyDownloading =
    whisper.kind === "downloading" || (ttsProvider !== "gemini" && ttsModelStatus.kind === "downloading")

  useEffect(() => {
    setTtsProvider(project.ttsSettings?.provider ?? DEFAULT_TTS_PROVIDER)
    setGeminiKey(project.ttsSettings?.apiKey ?? "")
  }, [project.ttsSettings?.provider, project.ttsSettings?.apiKey])

  async function saveTtsSettings(overrides: Partial<ProjectTtsSettings>) {
    const updated = await patchProject(project.id, (latest) => {
      const base = latest.ttsSettings
      return {
        ...latest,
        ttsSettings: {
          provider: overrides.provider ?? base?.provider ?? DEFAULT_TTS_PROVIDER,
          apiKey: Object.prototype.hasOwnProperty.call(overrides, "apiKey") ? overrides.apiKey : base?.apiKey,
          voices: overrides.voices ?? base?.voices,
          defaultVoiceId: Object.prototype.hasOwnProperty.call(overrides, "defaultVoiceId") ? overrides.defaultVoiceId : base?.defaultVoiceId,
        },
      }
    })
    if (updated) onUpdated(updated)
  }

  const handleStart = async () => {
    setError(null)
    storeAllFeaturesConsent()
    try {
      await prefetchAiModels({
        models: ttsProvider === "gemini" ? ["whisper"] : ["whisper", ttsProvider],
        mmsLanguage: DEFAULT_MMS_LANGUAGE,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Gemini is the promptable cloud voice path. Kokoro and MMS keep
        synthesis local after their first browser download; Whisper
        transcription runs locally for all providers.
      </p>

      <div className="space-y-2">
        {TTS_PROVIDER_INFOS.map((info) => (
          <button
            key={info.id}
            type="button"
            onClick={() => {
              setTtsProvider(info.id)
              void saveTtsSettings({ provider: info.id })
            }}
            aria-pressed={ttsProvider === info.id}
            className={
              "w-full rounded-lg border p-3 text-left transition-colors " +
              (ttsProvider === info.id ? "border-primary bg-primary/5" : "hover:bg-accent/40")
            }
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <span>{info.title}</span>
              {info.badge && (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                  {info.badge}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{info.hint}</p>
          </button>
        ))}
      </div>

      {ttsProvider === "gemini" && (
        <div className="space-y-1 rounded-md bg-muted/30 p-2">
          <Label htmlFor="setup-gemini-tts-key" className="text-xs">
            Gemini API key
          </Label>
          <Input
            id="setup-gemini-tts-key"
            type="password"
            value={geminiKey}
            onChange={(e) => setGeminiKey(e.target.value)}
            onBlur={() => void saveTtsSettings({ provider: "gemini", apiKey: geminiKey.trim() || undefined })}
            placeholder="AIza..."
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Stored locally in this browser and sent directly to Google for voice generation.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <ModelRow label="Whisper (transcription)" sizeMb={140} status={whisper} />
        {ttsProvider === "kokoro" && (
          <ModelRow label="Kokoro (local text-to-speech)" sizeMb={80} status={kokoro} />
        )}
        {ttsProvider === "mms" && (
          <ModelRow label="MMS (multilingual text-to-speech)" sizeMb={130} status={mms} />
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleStart}
          disabled={allReady || anyDownloading}
        >
          {allReady
            ? "Ready"
            : anyDownloading
              ? "Downloading in background…"
              : ttsProvider === "gemini"
                ? "Download transcription model"
                : "Download local models"}
        </Button>
        {anyDownloading && (
          <span className="text-xs text-muted-foreground">
            You can keep working — this won't block you.
          </span>
        )}
        {allReady && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            {ttsProvider === "gemini"
              ? "Ready to transcribe locally and generate voice with Gemini."
              : "Ready to transcribe and synthesize locally."}
          </span>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
