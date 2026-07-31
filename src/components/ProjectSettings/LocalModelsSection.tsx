// Manage the in-browser AI model weights (Whisper transcription, Kokoro + MMS
// voices). These live in the browser's Cache Storage and are SHARED across
// every project on this device — downloading once here speeds up the first
// transcribe / synth everywhere. Lets the user see what's downloaded, pull a
// fresh copy, retry a failed download, or reclaim disk by clearing one.
//
// Lives on the personal Preferences page (device-scoped, like the model cache
// itself). Project Settings links here rather than duplicating the controls.

import { useEffect, useState } from "react"
import { CheckCircle2, AlertCircle, Download, RotateCw, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SettingsGroup } from "@/components/ui/page"
import {
  clearPrefetchStatus,
  hydratePrefetchStatus,
  prefetchAiModels,
  useModelStatus,
  type ModelId,
} from "@/lib/audio/prefetch"
import { clearStoredConsent } from "@/lib/audio/ai-consent"
import { DEFAULT_MMS_LANGUAGE } from "@/lib/audio/tts-providers"

interface ModelMeta {
  id: ModelId
  label: string
  sizeMb: number
  blurb: string
}

const MODELS: ModelMeta[] = [
  {
    id: "whisper",
    label: "Whisper",
    sizeMb: 140,
    blurb: "Transcribes recordings and adds word-level timing for karaoke playback.",
  },
  {
    id: "kokoro",
    label: "Kokoro",
    sizeMb: 80,
    blurb: "English text-to-speech that runs locally after a one-time download.",
  },
  {
    id: "mms",
    label: "MMS",
    sizeMb: 130,
    blurb: "Multilingual text-to-speech — one language model per download.",
  },
]

export function LocalModelsSection() {
  // Derive ready-state from Cache Storage on mount so the section reflects
  // what's actually downloaded, not just what was fetched this session.
  useEffect(() => {
    void hydratePrefetchStatus()
  }, [])

  return (
    <div id="local-models">
      <SettingsGroup label="On-device models">
        {MODELS.map((meta) => (
          <ModelRow key={meta.id} meta={meta} />
        ))}
      </SettingsGroup>
    </div>
  )
}

function ModelRow({ meta }: { meta: ModelMeta }) {
  const status = useModelStatus(meta.id)
  const [busy, setBusy] = useState(false)

  const isReady = status.kind === "ready"
  const isDownloading = status.kind === "downloading" || busy
  const isError = status.kind === "error"

  const download = async () => {
    setBusy(true)
    try {
      await prefetchAiModels({
        models: [meta.id],
        ...(meta.id === "mms" ? { mmsLanguage: DEFAULT_MMS_LANGUAGE } : {}),
      })
    } catch {
      // Error surfaces via useModelStatus → the inline message below.
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    await clearPrefetchStatus(meta.id)
    // Drop the stored consent too, so re-downloading re-asks for the (now
    // re-incurred) download. Keeps the consent flag honest about disk state.
    clearStoredConsent(meta.id)
  }

  return (
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{meta.label}</span>
          <StatusBadge status={status} sizeMb={meta.sizeMb} />
        </div>
        <p className="text-xs text-muted-foreground">{meta.blurb}</p>
        {status.kind === "downloading" && <DownloadBar loaded={status.loaded} total={status.total} />}
        {isError && <p className="text-xs text-destructive">{status.message}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isError ? (
          <Button size="sm" variant="outline" onClick={download} disabled={isDownloading}>
            <RotateCw /> Retry
          </Button>
        ) : isReady ? (
          <>
            <Button size="sm" variant="ghost" onClick={download} disabled={isDownloading}>
              <Download /> Re-download
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={clear}
              disabled={isDownloading}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 /> Clear
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={download} disabled={isDownloading}>
            {isDownloading ? <Spinner /> : <Download />}
            {isDownloading ? "Downloading…" : "Download"}
          </Button>
        )}
      </div>
    </div>
  )
}

function StatusBadge({
  status,
  sizeMb,
}: {
  status: ReturnType<typeof useModelStatus>
  sizeMb: number
}) {
  if (status.kind === "ready") {
    return (
      <Badge variant="secondary">
        <CheckCircle2 data-icon="inline-start" />
        Downloaded
      </Badge>
    )
  }
  if (status.kind === "error") {
    return (
      <Badge variant="destructive">
        <AlertCircle data-icon="inline-start" />
        Failed
      </Badge>
    )
  }
  if (status.kind === "downloading") {
    return (
      <Badge variant="secondary">
        <Spinner data-icon="inline-start" />
        Downloading
      </Badge>
    )
  }
  return (
    <Badge variant="outline">{sizeMb} MB · not downloaded</Badge>
  )
}

function DownloadBar({ loaded, total }: { loaded: number; total: number }) {
  const pct = total > 0 ? Math.round((loaded / total) * 100) : null
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-md bg-primary transition-[width] duration-150"
          style={{ width: `${pct ?? 8}%` }}
        />
      </div>
      {pct != null && <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground">{pct}%</span>}
    </div>
  )
}
