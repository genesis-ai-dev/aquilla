// Optional onboarding step: download the in-browser AI models in the
// background so transcription + TTS feel instant the first time the user
// triggers them. Setting the consent flag here also suppresses the per-
// feature consent dialog later in the session.

import { useState } from "react"
import { CheckCircle2, Download, AlertCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { prefetchAiModels, useModelStatus } from "@/lib/audio/prefetch"
import { storeAllFeaturesConsent } from "@/lib/audio/ai-consent"

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

export function AiModelsStep() {
  const whisper = useModelStatus("whisper")
  const kokoro = useModelStatus("kokoro")
  const [error, setError] = useState<string | null>(null)
  const allReady = whisper.kind === "ready" && kokoro.kind === "ready"
  const anyDownloading = whisper.kind === "downloading" || kokoro.kind === "downloading"

  const handleStart = async () => {
    setError(null)
    storeAllFeaturesConsent()
    try {
      await prefetchAiModels()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Audio transcription and text-to-speech run entirely in your browser —
        nothing leaves your device. Downloading the models now (~220 MB total)
        means transcription and AI voice will feel instant the first time you
        use them.
      </p>

      <div className="space-y-2">
        <ModelRow label="Whisper (transcription)" sizeMb={140} status={whisper} />
        <ModelRow label="Kokoro (text-to-speech)" sizeMb={80} status={kokoro} />
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleStart}
          disabled={allReady || anyDownloading}
        >
          {allReady
            ? "Downloaded"
            : anyDownloading
              ? "Downloading in background…"
              : "Download in background"}
        </Button>
        {anyDownloading && (
          <span className="text-xs text-muted-foreground">
            You can keep working — this won't block you.
          </span>
        )}
        {allReady && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            Ready to transcribe and synthesize offline.
          </span>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
