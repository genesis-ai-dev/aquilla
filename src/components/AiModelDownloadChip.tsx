// Floating chip that surfaces background AI-model downloads kicked off from
// the onboarding checklist. Shows live percentages while downloading; once
// every previously-downloading model finishes, briefly displays a "Ready"
// confirmation so the user knows the work completed before the chip hides.

import { CheckCircle2, Loader2, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useModelStatus, type ModelId } from "@/lib/audio/prefetch"
import { cn } from "@/lib/utils"

const READY_FLASH_MS = 4000

function pct(loaded: number, total: number): number | null {
  if (total <= 0) return null
  return Math.round((loaded / total) * 100)
}

interface ModelView {
  id: ModelId
  label: string
  loaded: number
  total: number
}

export function AiModelDownloadChip() {
  const whisper = useModelStatus("whisper")
  const kokoro = useModelStatus("kokoro")
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
    checkOne("kokoro", kokoro.kind)
  }, [whisper.kind, kokoro.kind])

  // Auto-clear the flash after a few seconds.
  useEffect(() => {
    if (readyFlash.length === 0) return
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    flashTimeoutRef.current = setTimeout(() => setReadyFlash([]), READY_FLASH_MS)
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    }
  }, [readyFlash])

  const downloads: ModelView[] = []
  if (whisper.kind === "downloading") downloads.push({ id: "whisper", label: "Whisper", loaded: whisper.loaded, total: whisper.total })
  if (kokoro.kind === "downloading") downloads.push({ id: "kokoro", label: "Kokoro", loaded: kokoro.loaded, total: kokoro.total })

  if (dismissed) return null
  if (downloads.length === 0 && readyFlash.length === 0) return null

  const allReady = downloads.length === 0 && readyFlash.length > 0

  return (
    <div
      className={cn(
        // Anchored bottom-left so we don't collide with the workspace's
        // bottom-right "Synced" pill.
        "fixed bottom-4 left-4 z-40 w-72 rounded-lg border bg-popover p-3 text-xs shadow-lg",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        {allReady ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        )}
        <span className="font-medium">
          {allReady ? "AI models ready" : "Downloading AI models"}
        </span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Hide"
          className="ml-auto flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {downloads.length > 0 && (
        <ul className="space-y-1.5">
          {downloads.map((d) => {
            const p = pct(d.loaded, d.total)
            return (
              <li key={d.id} className="space-y-0.5">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{d.label}</span>
                  <span className="tabular-nums">{p != null ? `${p}%` : "starting…"}</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-[width] duration-150"
                    style={{ width: `${p ?? 8}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {readyFlash.length > 0 && (
        <ul className="space-y-1">
          {readyFlash.map((id) => (
            <li key={id} className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" />
              <span className="capitalize">{id}</span>
              <span className="text-muted-foreground">ready to use</span>
            </li>
          ))}
        </ul>
      )}

      {downloads.length > 0 && (
        <p className="mt-2 text-[10px] text-muted-foreground">
          Runs in the background — keep working as normal.
        </p>
      )}
    </div>
  )
}
