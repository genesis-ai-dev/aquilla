// Floating chip that surfaces background AI-model downloads kicked off from
// the onboarding checklist. Each model keeps the same row (green bar, percent
// or a right-side check) until the whole batch finishes; then a brief "Ready"
// confirmation shows so the user knows the work completed before the chip hides.

import { AlertCircle, CheckCircle2, RotateCw, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { prefetchAiModels, useModelStatus, type ModelId } from "@/lib/audio/prefetch"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"

const READY_FLASH_MS = 4000

function pct(loaded: number, total: number): number | null {
  if (total <= 0) return null
  return Math.round((loaded / total) * 100)
}

const MODEL_ORDER: ModelId[] = ["whisper", "mms"]

interface ModelView {
  id: ModelId
  label: string
  loaded: number
  total: number
  ready: boolean
}

interface ErrorView {
  id: ModelId
  label: string
  message: string
}

// i18n-exempt product/model names — "Whisper" (OpenAI's ASR model) is the
// same category of atomic proper noun as its sibling here ("MMS" is an
// all-caps acronym the scanner's own heuristic skips). Never translated.
const LABELS: Record<ModelId, string> = { whisper: "Whisper", mms: "MMS" }

export function AiModelDownloadChip() {
  const t = useT()
  const whisper = useModelStatus("whisper")
  const mms = useModelStatus("mms")
  const [dismissed, setDismissed] = useState(false)
  const [readyFlash, setReadyFlash] = useState<ModelId[]>([])
  const seenDownloadingRef = useRef<Set<ModelId>>(new Set())
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track which models have ever been seen downloading in this session, so
  // when they switch to "ready" we can flash a confirmation. Models hydrated
  // from localStorage as already-ready don't trigger a flash.
  useEffect(() => {
    const checkOne = (id: ModelId, kind: string) => {
      if (kind === "downloading") seenDownloadingRef.current.add(id)
      if (kind === "ready" && seenDownloadingRef.current.has(id)) {
        seenDownloadingRef.current.delete(id)
        setReadyFlash((prev) => (prev.includes(id) ? prev : [...prev, id]))
      }
    }
    checkOne("whisper", whisper.kind)
    checkOne("mms", mms.kind)
  }, [whisper.kind, mms.kind])

  // Hold completed rows in the same list until every model in the batch is
  // done. Only then flash the all-ready confirmation and auto-hide.
  useEffect(() => {
    if (readyFlash.length === 0) return
    const stillGoing =
      whisper.kind === "downloading" ||
      mms.kind === "downloading" ||
      whisper.kind === "error" ||
      mms.kind === "error"
    if (stillGoing) return
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    flashTimeoutRef.current = setTimeout(() => setReadyFlash([]), READY_FLASH_MS)
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    }
  }, [readyFlash, whisper.kind, mms.kind])

  const byId: Record<ModelId, typeof whisper> = { whisper, mms }
  const rows: ModelView[] = MODEL_ORDER.flatMap((id): ModelView[] => {
    const status = byId[id]
    if (status.kind === "downloading") {
      return [{ id, label: LABELS[id], loaded: status.loaded, total: status.total, ready: false }]
    }
    if (readyFlash.includes(id)) {
      return [{ id, label: LABELS[id], loaded: 1, total: 1, ready: true }]
    }
    return []
  })
  const downloads = rows.filter((r) => !r.ready)

  const errors: ErrorView[] = []
  if (whisper.kind === "error") errors.push({ id: "whisper", label: LABELS.whisper, message: whisper.message })
  if (mms.kind === "error") errors.push({ id: "mms", label: LABELS.mms, message: mms.message })

  // Re-show the chip if a new failure happens after the user dismissed an
  // earlier success — the error needs attention.
  useEffect(() => {
    if (errors.length > 0) setDismissed(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whisper.kind, mms.kind])

  if (dismissed) return null
  if (downloads.length === 0 && readyFlash.length === 0 && errors.length === 0) return null

  const allReady = downloads.length === 0 && errors.length === 0 && readyFlash.length > 0
  const hasErrors = errors.length > 0

  const handleRetry = (id: ModelId): void => {
    void prefetchAiModels({ models: [id] })
  }

  return (
    <div
      className={cn(
        // Anchored at the reading-start corner so we don't collide with the
        // workspace's "Synced" pill, which sits at the opposite (end) corner.
        "fixed bottom-4 start-4 z-30 w-72 rounded-xl border bg-popover p-3 text-xs text-popover-foreground shadow-lg",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        {hasErrors ? (
          <AlertCircle className="h-3.5 w-3.5 text-destructive" />
        ) : allReady ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <Spinner className="size-3.5 text-primary" />
        )}
        <span className="font-medium">
          {hasErrors
            ? errors.length === 1 ? `${errors[0].label} download failed` : "AI model downloads failed"
            : allReady ? "AI models ready" : "Downloading AI models"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setDismissed(true)}
          aria-label={t("org.projectOverview.hide")}
          className="ms-auto size-5 text-muted-foreground/60 hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {rows.length > 0 && (
        <ul className="space-y-1.5">
          {rows.map((d) => {
            const p = d.ready ? 100 : pct(d.loaded, d.total)
            return (
              <li key={d.id} className="space-y-0.5">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{d.label}</span>
                  {d.ready ? (
                    <span aria-label={`${d.label} ${t("workspace.aiDownloadChip.readyToUse")}`}>
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                    </span>
                  ) : (
                    <span className="tabular-nums">{p != null ? `${p}%` : "starting…"}</span>
                  )}
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-emerald-500 transition-[width] duration-150"
                    style={{ width: `${p ?? 8}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {errors.length > 0 && (
        <ul className="space-y-2">
          {errors.map((err) => (
            <li key={err.id} className="space-y-1">
              <AppTooltip content={err.message} className="max-w-xs">
                <p className="text-[11px] leading-snug text-destructive">
                  <span className="font-medium">{err.label}:</span>{" "}
                  {err.message}
                </p>
              </AppTooltip>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => handleRetry(err.id)}
              >
                <RotateCw />
                {t("common.retry")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {downloads.length > 0 && (
        <p className="mt-2 text-[10px] text-muted-foreground">
          {t("workspace.aiDownloadChip.runsInBackground")}
        </p>
      )}
    </div>
  )
}
