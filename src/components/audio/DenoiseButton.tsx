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
import { AppTooltip } from "@/components/ui/tooltip"
import type { FrontierSession } from "@/lib/frontier/types"
import { isDenoisedAudioId } from "@/lib/audio/upload"
import { isDenoiseSupported } from "@/lib/audio/denoise"
import { denoiseTake } from "@/lib/audio/denoise-take"
import { emitCellAudioSelect } from "@/lib/sync/events-emit"
import {
  injectOptimisticAudioAttachment,
  notifyAudioAttachmentsChanged,
} from "@/lib/audio/audio-attachments-bus"
import { useT } from "@/lib/i18n/I18nProvider"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { toUserFacingError } from "@/lib/errors/user-error"

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
  /** AQU-1462: lane the member is working in. Omitted for the default lane. */
  targetLang?: string
}

export function DenoiseButton(props: Props) {
  const t = useT()
  const {
    projectId, fileId, cellId, selectedAudioId, selectedUrl,
    referenceAudioId, originalUrl, originalDurationMs, author, session, editable,
    targetLang,
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
        ...(targetLang ? { targetLang } : {}),
      })
      // Success: the cleaned take is optimistically selected, so this component
      // re-renders into the "Noise removed" state on the next pass.
    } catch (e) {
      // AQU-510: route through AQU-891's categoriser so the reason reads in the
      // active language instead of a raw model/decoder throw.
      setError(categorizeAiError(e instanceof Error ? e.message : String(e)).body)
    } finally {
      setProcessing(false)
    }
  }, [canRun, processing, projectId, fileId, cellId, selectedAudioId, selectedUrl, author, session, targetLang])

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
        ...(targetLang ? { targetLang } : {}),
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
      // AQU-510: localized reason, not the raw throw (no `context` noun —
      // it would be interpolated untranslated).
      setError(toUserFacingError(e).message)
    } finally {
      setReverting(false)
    }
  }, [referenceAudioId, reverting, originalUrl, originalDurationMs, projectId, fileId, cellId, author, targetLang])

  if (isDenoised) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <AppTooltip content={t("workspace.denoise.removedTooltip")}>
          <Badge
            variant="outline"
            className="border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          >
            <Check className="h-3 w-3" />
            {t("workspace.denoise.removedBadge")}
          </Badge>
        </AppTooltip>
        {referenceAudioId && (
          <AppTooltip content={t("workspace.denoise.revertTooltip")}>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void handleRevert()}
              disabled={!editable || reverting || !session?.jwt}
            >
              {reverting ? <Spinner className="size-3" /> : <RotateCcw className="h-3 w-3" />}
              {t("workspace.denoise.revertButton")}
            </Button>
          </AppTooltip>
        )}
        {error && <span className="text-[11px] text-destructive">{error}</span>}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <AppTooltip content={
        !supported
          ? "Noise removal isn't supported in this browser"
          : "Remove background noise (on-device) — adds a cleaned take"
      }>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => void handleDenoise()}
          disabled={!canRun || processing}
        >
          <Bird className={processing ? "h-3 w-3 animate-pulse" : "h-3 w-3"} />
          {processing ? "Removing noise…" : error ? "Retry noise removal" : "Remove noise"}
        </Button>
      </AppTooltip>
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </div>
  )
}
