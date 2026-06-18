// Inline "Remove noise" affordance for the cell audio tab. Three states driven
// by the currently-selected recording take:
//   • original take          → "Remove noise" (Bird), runs RNNoise on-device.
//   • processing              → animated "Removing noise…".
//   • denoised take selected  → "Noise removed ✓" + "Revert" (back to original).
//
// Denoising adds a NEW take (the original is preserved); revert just re-selects
// the source take recorded on the cleaned take's `referenceAudioId`.

import { useCallback, useState } from "react"
import { Bird, Check, RotateCcw } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { FrontierSession } from "@/lib/frontier/types"
import { isDenoisedAudioId } from "@/lib/audio/upload"
import { isDenoiseSupported } from "@/lib/audio/denoise"
import { denoiseTake } from "@/lib/audio/denoise-take"
import { emitCellAudioSelect } from "@/lib/sync/events-emit"
import {
  injectOptimisticAudioAttachment,
  notifyAudioAttachmentsChanged,
} from "@/lib/audio/audio-attachments-bus"

interface Props {
  projectId: string
  fileId: string
  cellId: string
  /** Stored id of the active recording take. */
  selectedAudioId: string
  /** frontier-audio:// url of the active recording take (denoise source). */
  selectedUrl: string
  /** When the active take is denoised: the source take it was derived from. */
  referenceAudioId: string | null
  /** url of that source take, for an instant optimistic revert. */
  originalUrl: string | null
  originalDurationMs: number | null
  author: string
  session: FrontierSession | null
  editable: boolean
}

const PILL =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40"

export function DenoiseButton(props: Props) {
  const {
    projectId, fileId, cellId, selectedAudioId, selectedUrl,
    referenceAudioId, originalUrl, originalDurationMs, author, session, editable,
  } = props

  const [processing, setProcessing] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isDenoised = isDenoisedAudioId(selectedAudioId)
  const supported = isDenoiseSupported()
  const canRun = editable && Boolean(session?.jwt) && supported

  const handleDenoise = useCallback(async () => {
    if (!canRun || processing) return
    setError(null)
    setProcessing(true)
    try {
      await denoiseTake({
        projectId, fileId, cellId,
        sourceAudioId: selectedAudioId,
        sourceUrl: selectedUrl,
        author,
        session,
      })
      // Success: the cleaned take is optimistically selected, so this component
      // re-renders into the "Noise removed" state on the next pass.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProcessing(false)
    }
  }, [canRun, processing, projectId, fileId, cellId, selectedAudioId, selectedUrl, author, session])

  const handleRevert = useCallback(async () => {
    if (!referenceAudioId || reverting) return
    setError(null)
    setReverting(true)
    try {
      // Optimistically re-select the original by re-injecting its attachment
      // (a recording-slot injection also flips selectedAudioId), so the UI
      // reverts instantly; the emitted select is reconciled by the next read.
      if (originalUrl) {
        injectOptimisticAudioAttachment(fileId, cellId, {
          audioId: referenceAudioId,
          url: originalUrl,
          slot: "recording",
          mimeType: null,
          voiceId: null,
          referenceAudioId: null,
          durationMs: originalDurationMs,
          trimStartMs: null,
          trimEndMs: null,
        })
      }
      await emitCellAudioSelect({
        projectId, fileId, cellId,
        audioId: referenceAudioId,
        slot: "recording",
        author,
      })
      notifyAudioAttachmentsChanged(fileId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setReverting(false)
    }
  }, [referenceAudioId, reverting, originalUrl, originalDurationMs, projectId, fileId, cellId, author])

  if (isDenoised) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(PILL, "border border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400")}
          title="Background noise removed from this take"
        >
          <Check className="h-3 w-3" />
          Noise removed
        </span>
        {referenceAudioId && (
          <button
            type="button"
            onClick={() => void handleRevert()}
            disabled={!editable || reverting || !session?.jwt}
            title="Switch back to the original recording"
            className={cn(PILL, "bg-card text-foreground shadow-neu-sm hover:shadow-neu active:shadow-neu-pressed")}
          >
            {reverting ? <Spinner className="size-3" /> : <RotateCcw className="h-3 w-3" />}
            Revert
          </button>
        )}
        {error && <span className="text-[11px] text-destructive">{error}</span>}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => void handleDenoise()}
        disabled={!canRun || processing}
        title={
          !supported
            ? "Noise removal isn't supported in this browser"
            : "Remove background noise (on-device) — adds a cleaned take"
        }
        className={cn(PILL, "bg-card text-foreground shadow-neu-sm hover:shadow-neu active:shadow-neu-pressed")}
      >
        <Bird className={cn("h-3 w-3", processing && "animate-pulse")} />
        {processing ? "Removing noise…" : error ? "Retry noise removal" : "Remove noise"}
      </button>
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </div>
  )
}
