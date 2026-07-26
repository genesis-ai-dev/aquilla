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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
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
      const revertP = emitCellAudioSelect({
        projectId, fileId, cellId,
        audioId: referenceAudioId,
        slot: "recording",
        author,
      })
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
        }, revertP)
      }
      await revertP
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
        <Badge
          variant="outline"
          title="Background noise removed from this take"
          className="border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        >
          <Check className="h-3 w-3" />
          Noise removed
        </Badge>
        {referenceAudioId && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void handleRevert()}
            disabled={!editable || reverting || !session?.jwt}
            title="Switch back to the original recording"
          >
            {reverting ? <Spinner className="size-3" /> : <RotateCcw className="h-3 w-3" />}
            Revert
          </Button>
        )}
        {error && <span className="text-[11px] text-destructive">{error}</span>}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => void handleDenoise()}
        disabled={!canRun || processing}
        title={
          !supported
            ? "Noise removal isn't supported in this browser"
            : "Remove background noise (on-device) — adds a cleaned take"
        }
      >
        <Bird className={processing ? "h-3 w-3 animate-pulse" : "h-3 w-3"} />
        {processing ? "Removing noise…" : error ? "Retry noise removal" : "Remove noise"}
      </Button>
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </div>
  )
}
