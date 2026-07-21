// Tiny status pill rendered in the cell gutter while Whisper runs. Shows the
// model-download progress on first use, then a brief "transcribing" spinner,
// then a 5-second "✓ N words" confirmation so the user knows transcription
// completed (the karaoke decoration only shows when audio plays). Errors are
// click-to-expand: full message + actions (retry, dismiss).

import { useEffect, useRef, useState } from "react"
import { CheckCircle2, Sparkles, Download } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Badge, badgeVariants } from "@/components/ui/badge"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  clearTranscribeStatus,
  useTranscribeStatus,
  type TranscribeStatus,
} from "@/lib/audio/transcribe-status"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { CellAiStatusPopover, type AiStatusAction } from "./CellAiStatusPopover"

interface Props {
  audioId: string | undefined
  hasTimings: boolean
  onJumpToTranscript?: () => void
  /** Optional: invoked when the user clicks "Retry" in the error popover.
   *  Without this, only "Dismiss" is offered. */
  onRetry?: () => void
}

const SUCCESS_FLASH_MS = 5000

// Shared compact sizing so every state reads as one consistent gutter pill.
const PILL = "h-5 gap-1 px-1.5 py-0 text-[10px]"

export function CellTranscribeBadge({ audioId, hasTimings: _hasTimings, onJumpToTranscript, onRetry }: Props) {
  const status = useTranscribeStatus(audioId)
  const [flashedDone, setFlashedDone] = useState<TranscribeStatus & { kind: "done" } | null>(null)
  const lastSeenKindRef = useRef<TranscribeStatus["kind"]>("idle")
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Flash a "✓ N words" success pill for a few seconds when transcription
  // completes — the timings land durably and the badge would otherwise vanish
  // silently.
  useEffect(() => {
    const wasActive = lastSeenKindRef.current === "loading" || lastSeenKindRef.current === "transcribing"
    if (status.kind === "done" && wasActive) {
      setFlashedDone(status as TranscribeStatus & { kind: "done" })
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => setFlashedDone(null), SUCCESS_FLASH_MS)
    }
    lastSeenKindRef.current = status.kind
  }, [status])

  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current) }, [])

  if (!audioId) return null

  if (flashedDone) {
    const secs = (flashedDone.durationMs / 1000).toFixed(1)
    const words = `${flashedDone.wordCount} word${flashedDone.wordCount === 1 ? "" : "s"}`
    return (
      <AppTooltip content={`Transcribed ${words} in ${secs}s${onJumpToTranscript ? "; click to view" : ""}`}>
        <button
          type="button"
          onClick={onJumpToTranscript}
          className={cn(
            badgeVariants({ variant: "secondary" }),
            PILL,
            "text-emerald-700 dark:text-emerald-400",
          )}
        >
          <CheckCircle2 className="h-2.5 w-2.5" />
          <span className="tabular-nums">{flashedDone.wordCount}w</span>
        </button>
      </AppTooltip>
    )
  }

  if (status.kind === "idle" || status.kind === "done") return null

  if (status.kind === "loading") {
    const pct = status.total > 0 ? Math.round((status.loaded / status.total) * 100) : null
    return (
      <AppTooltip content={pct != null ? `Downloading transcription model (${pct}%)…` : "Loading transcription model…"}>
        <Badge
          variant="secondary"
          className={cn(PILL, "text-amber-700 dark:text-amber-300")}
        >
          {pct != null ? <Download className="h-2.5 w-2.5" /> : <Spinner className="size-2.5" />}
          {pct != null ? <span className="tabular-nums">{pct}%</span> : <span>load</span>}
        </Badge>
      </AppTooltip>
    )
  }

  if (status.kind === "transcribing") {
    return (
      <AppTooltip content="Transcribing audio…">
        <Badge variant="secondary" className={cn(PILL, "text-primary")}>
          <Sparkles className="h-2.5 w-2.5 animate-pulse" />
          <span>transcribing</span>
        </Badge>
      </AppTooltip>
    )
  }

  if (status.kind === "error") {
    const error = categorizeAiError(status.message)
    const dismiss = () => { if (audioId) clearTranscribeStatus(audioId) }
    const actions: AiStatusAction[] = []
    if (onRetry) {
      actions.push({ label: "Retry", primary: true, onClick: () => { dismiss(); onRetry() } })
    }
    return (
      <CellAiStatusPopover
        error={error}
        actions={actions}
        onDismiss={dismiss}
        trigger={
          <button
            type="button"
            className={cn(badgeVariants({ variant: "destructive" }), PILL)}
          >
            Transcription failed
          </button>
        }
      />
    )
  }

  return null
}
