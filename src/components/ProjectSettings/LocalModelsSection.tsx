// Manage the in-browser AI model weights (Whisper transcription, MMS
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
import { clearStoredConsent, storeModelConsent } from "@/lib/audio/ai-consent"
import { DEFAULT_MMS_LANGUAGE } from "@/lib/audio/tts-providers"
import { useT } from "@/lib/i18n/I18nProvider"

interface ModelMeta {
  id: ModelId
  label: string
  sizeMb: number
  blurbKey: Parameters<ReturnType<typeof useT>>[0]
}

const MODELS: ModelMeta[] = [
  {
    id: "whisper",
    // i18n-exempt: model/product name, same treatment as the sibling "MMS"
    // label below (already atomic — untranslated in every locale).
    label: "Whisper",
    sizeMb: 140,
    blurbKey: "audio.consent.whisper.short",
  },
  {
    id: "mms",
    label: "MMS",
    sizeMb: 130,
    blurbKey: "audio.consent.mms.short",
  },
]

export function LocalModelsSection() {
  const t = useT()
  // Derive ready-state from Cache Storage on mount so the section reflects
  // what's actually downloaded, not just what was fetched this session.
  useEffect(() => {
    void hydratePrefetchStatus()
  }, [])

  return (
    <div id="local-models">
      <SettingsGroup label={t("projectSettings.localModels.onDeviceLabel")}>
        {MODELS.map((meta) => (
          <ModelRow key={meta.id} meta={meta} />
        ))}
      </SettingsGroup>
    </div>
  )
}

function ModelRow({ meta }: { meta: ModelMeta }) {
  const t = useT()
  const status = useModelStatus(meta.id)
  const [busy, setBusy] = useState(false)

  const isReady = status.kind === "ready"
  const isDownloading = status.kind === "downloading" || busy
  const isError = status.kind === "error"

  const download = async () => {
    storeModelConsent(meta.id)
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
        <p className="text-xs text-muted-foreground">{t(meta.blurbKey)}</p>
        {status.kind === "downloading" && <DownloadBar loaded={status.loaded} total={status.total} />}
        {isError && <p className="text-xs text-destructive">{status.message}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isError ? (
          <Button variant="outline" onClick={download} disabled={isDownloading}>
            <RotateCw /> {t("common.retry")}
          </Button>
        ) : isReady ? (
          <>
            <Button variant="ghost" onClick={download} disabled={isDownloading}>
              <Download /> Re-download
            </Button>
            <Button
              variant="ghost"
              onClick={clear}
              disabled={isDownloading}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 /> {t("common.clear")}
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={download} disabled={isDownloading}>
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
  const t = useT()
  if (status.kind === "ready") {
    return (
      <Badge variant="secondary">
        <CheckCircle2 data-icon="inline-start" />
        {t("projectSettings.localModels.downloadedBadge")}
      </Badge>
    )
  }
  if (status.kind === "error") {
    return (
      <Badge variant="destructive">
        <AlertCircle data-icon="inline-start" />
        {t("onboarding.checklist.aiModels.statusFailed")}
      </Badge>
    )
  }
  if (status.kind === "downloading") {
    return (
      <Badge variant="secondary">
        <Spinner data-icon="inline-start" />
        {t("onboarding.checklist.aiModels.statusDownloading")}
      </Badge>
    )
  }
  return (
    <Badge variant="outline">{t("projectSettings.localModels.notDownloadedBadge", { size: sizeMb })}</Badge>
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
      {pct != null && <span className="w-8 text-end text-[10px] tabular-nums text-muted-foreground">{pct}%</span>}
    </div>
  )
}
