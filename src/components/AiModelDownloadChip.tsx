// Download and memory-load notices for the in-browser AI models. Each phase is
// one toast whose body is AiModelToastBody: the same bar per model, filled by
// download percent or pulsing while the weights load into memory. The body
// reads the status store itself, so the bars move without rebuilding the toast.

import { useEffect, useRef } from "react"
import { toast } from "@/components/ui/toast"
import { prefetchAiModels, useModelStatus, type ModelId, type ModelPrefetchStatus } from "@/lib/audio/prefetch"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

const DOWNLOAD_TOAST_ID = "ai-model-download"
const LOAD_TOAST_ID = "ai-model-load"
const ERROR_TOAST_ID = "ai-model-error"

const LABELS: Record<ModelId, string> = { whisper: "Whisper", mms: "MMS" }
const MODEL_ORDER = ["whisper", "mms"] as const

function percent(loaded: number, total: number): number | null {
  if (total <= 0) return null
  return Math.min(100, Math.round((loaded / total) * 100))
}

/** One bar per model. It stays neutral while bytes are still coming, and turns green once that download has finished. */
function ModelLoadBar({ label, pct, complete }: { label: string; pct: number | null; complete: boolean }) {
  const t = useT()
  const known = pct != null
  const done = complete || pct === 100
  return (
    <li className="space-y-0.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{known ? `${pct}%` : t("workspace.aiModelToast.starting")}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? pct : undefined}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            done ? "bg-emerald-500" : "bg-primary",
            // w-0 is the resting width, including while bytes have not started.
            // A block box otherwise starts full and the width transition eases
            // it back down to the real value.
            known
              ? cn("w-0", pct > 0 && "transition-[width] duration-150")
              : complete
                ? "w-2/5 animate-pulse"
                : "w-0",
          )}
          style={known ? { width: `${pct}%` } : undefined}
        />
      </div>
    </li>
  )
}

function AiModelToastBody({ phase }: { phase: "download" | "load" }) {
  const whisper = useModelStatus("whisper")
  const mms = useModelStatus("mms")
  const byId: Record<ModelId, ModelPrefetchStatus> = { whisper, mms }
  const want = phase === "download" ? "downloading" : "loading"
  const rows = MODEL_ORDER.flatMap((id) => {
    const status = byId[id]
    if (status.kind !== want) return []
    return [{
      id,
      label: LABELS[id],
      pct: status.kind === "downloading" ? percent(status.loaded, status.total) : null,
      complete: status.kind === "loading",
    }]
  })
  if (rows.length === 0) return null

  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <ModelLoadBar key={row.id} label={row.label} pct={row.pct} complete={row.complete} />
      ))}
    </ul>
  )
}

export function AiModelDownloadChip() {
  const t = useT()
  const whisper = useModelStatus("whisper")
  const mms = useModelStatus("mms")
  const programmatic = useRef(false)
  const dismissed = useRef({ download: false, load: false, error: "" })
  const open = useRef({ download: false, load: "", error: "" })

  const downloading = whisper.kind === "downloading" || mms.kind === "downloading"
  const loadingIds = MODEL_ORDER.filter((id) => (id === "whisper" ? whisper : mms).kind === "loading")
  const loadShape = loadingIds.join(",")
  const errors: { id: ModelId; label: string; message: string }[] = []
  if (whisper.kind === "error") errors.push({ id: "whisper", label: LABELS.whisper, message: whisper.message })
  if (mms.kind === "error") errors.push({ id: "mms", label: LABELS.mms, message: mms.message })

  const errorKey = errors.map((e) => `${e.id}:${e.message}`).join("|")

  const closeToast = (id: string) => {
    programmatic.current = true
    toast.close(id)
    programmatic.current = false
  }

  useEffect(() => {
    if (!downloading) {
      closeToast(DOWNLOAD_TOAST_ID)
      open.current.download = false
      dismissed.current.download = false
    } else if (!dismissed.current.download && !open.current.download) {
      open.current.download = true
      toast.add({
        id: DOWNLOAD_TOAST_ID,
        type: "loading",
        timeout: 0,
        title: t("workspace.aiModelToast.downloading"),
        data: { body: <AiModelToastBody phase="download" /> },
        onClose: () => {
          if (programmatic.current) return
          dismissed.current.download = true
          open.current.download = false
        },
      })
    }

    if (!loadShape) {
      closeToast(LOAD_TOAST_ID)
      open.current.load = ""
      dismissed.current.load = false
    } else if (!dismissed.current.load && open.current.load !== loadShape) {
      const single = loadingIds.length === 1 ? loadingIds[0] : null
      open.current.load = loadShape
      toast.add({
        id: LOAD_TOAST_ID,
        type: "loading",
        timeout: 0,
        title: single
          ? t("workspace.aiModelToast.loadingNamed", { model: LABELS[single] })
          : t("workspace.aiModelToast.loadingMany"),
        // One model is a plain loading toast. Two models keep a bar each.
        // `data` must replace any previous body when the shape changes.
        data: single ? {} : { body: <AiModelToastBody phase="load" /> },
        onClose: () => {
          if (programmatic.current) return
          dismissed.current.load = true
          open.current.load = ""
        },
      })
    }

    if (!errorKey) {
      closeToast(ERROR_TOAST_ID)
      open.current.error = ""
      dismissed.current.error = ""
    } else if (dismissed.current.error !== errorKey && open.current.error !== errorKey) {
      open.current.error = errorKey
      const single = errors.length === 1 ? errors[0] : null
      toast.add({
        id: ERROR_TOAST_ID,
        type: "error",
        timeout: 0,
        title: single
          ? t("workspace.aiModelToast.downloadFailedNamed", { model: single.label })
          : t("workspace.aiModelToast.downloadFailed"),
        description: single ? single.message : errors.map((e) => `${e.label}: ${e.message}`).join(" "),
        actionProps: {
          children: t("common.retry"),
          onClick: () => {
            void prefetchAiModels({ models: errors.map((e) => e.id) })
          },
        },
        onClose: () => {
          if (programmatic.current) return
          dismissed.current.error = errorKey
        },
      })
    }
    // Toast bodies subscribe to byte progress themselves; this effect only
    // opens and closes each phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloading, loadShape, errorKey, t])

  useEffect(() => () => {
    programmatic.current = true
    toast.close(DOWNLOAD_TOAST_ID)
    toast.close(LOAD_TOAST_ID)
    toast.close(ERROR_TOAST_ID)
    programmatic.current = false
  }, [])

  return null
}
