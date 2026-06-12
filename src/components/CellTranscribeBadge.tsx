// Tiny status pill rendered in the cell gutter while Whisper runs. Shows the
// model-download progress on first use, then a brief "transcribing" spinner,
// then a 5-second "✓ N words" confirmation so the user knows transcription
// completed (the karaoke decoration only shows when audio plays). Errors are
// click-to-expand: full message + actions (retry, dismiss).

import { useEffect, useRef, useState } from "react"
import { CheckCircle2, Sparkles } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
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

export function CellTranscribeBadge({ audioId, hasTimings, onJumpToTranscript, onRetry }: Props) {
  const status = useTranscribeStatus(audioId)
  const [flashedDone, setFlashedDone] = useState<TranscribeStatus & { kind: "done" } | null>(null)
  const lastSeenKindRef = useRef<TranscribeStatus["kind"]>("idle")
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Flash a "✓ N words" success pill for a few seconds when transcription
  // completes — the timings land in Y.Doc and the badge would otherwise
  // vanish silently.
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
    const tooltip = onJumpToTranscript
      ? `Transcribed ${flashedDone.wordCount} word${flashedDone.wordCount === 1 ? "" : "s"} in ${(flashedDone.durationMs / 1000).toFixed(1)}s — click to view`
      : `Transcribed ${flashedDone.wordCount} word${flashedDone.wordCount === 1 ? "" : "s"} in ${(flashedDone.durationMs / 1000).toFixed(1)}s`
    return (
      <button
        type="button"
        onClick={onJumpToTranscript}
        title={tooltip}
        className={cn(
          "flex h-5 items-center gap-1 rounded px-1 text-[10px] font-medium transition-colors",
          "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
          onJumpToTranscript && "cursor-pointer hover:bg-emerald-500/25",
        )}
      >
        <CheckCircle2 className="h-2.5 w-2.5" />
        <span className="tabular-nums">{flashedDone.wordCount}w</span>
      </button>
    )
  }

  if (status.kind === "idle" || status.kind === "done") {
    if (hasTimings) return null
    if (status.kind === "done") return null
    return null
  }

  if (status.kind === "loading") {
    const pct = status.total > 0 ? Math.round((status.loaded / status.total) * 100) : null
    return (
      <button
        type="button"
        title={pct != null
          ? `Downloading transcription model (${pct}%)…`
          : "Loading transcription model…"}
        className={cn(
          "flex h-5 items-center gap-1 rounded px-1 text-[10px] font-medium",
          "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
        )}
      >
        <Spinner className="size-2.5" />
        {pct != null ? <span className="tabular-nums">{pct}%</span> : <span>load</span>}
      </button>
    )
  }

  if (status.kind === "transcribing") {
    return (
      <span
        title="Transcribing audio…"
        className={cn(
          "flex h-5 items-center gap-1 rounded px-1 text-[10px] font-medium",
          "bg-primary/10 text-primary",
        )}
      >
        <Sparkles className="h-2.5 w-2.5 animate-pulse" />
        <span>asr</span>
      </span>
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
            className="flex h-5 cursor-pointer items-center gap-1 rounded bg-destructive/10 px-1 text-[10px] font-medium text-destructive hover:bg-destructive/20"
          >
            <span>asr · failed</span>
          </button>
        }
      />
    )
  }

  return null
}
