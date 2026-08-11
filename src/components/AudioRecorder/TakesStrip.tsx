// Take management for a single cell's recording slot. Lists every recorded
// take, lets the user audition each, circle the keeper (the active clip in the
// "recording" slot), and delete rejects. Self-contained: resolves frontier
// audio URLs to playable blobs and emits cell.audio.select / cell.audio.remove.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bird, Check, Pause, Play, RotateCcw, Trash2 } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import type { FrontierSession } from "@/lib/frontier/types"
import { fetchCellAudio, isDenoisedAudioId, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { emitCellAudioSelect, emitCellAudioRemove } from "@/lib/sync/events-emit"
import { notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"

interface Props {
  projectId: string
  fileId: string
  cellId: string
  takes: AudioAttachmentOut[]
  selectedAudioId: string | null
  author: string
  session: FrontierSession | null
}

export function TakesStrip({ projectId, fileId, cellId, takes, selectedAudioId, author, session }: Props) {
  const t = useT()
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Optimistic selection: immediately reflects the last user intent while the
  // server round-trip is in flight. Cleared once the server-confirmed
  // selectedAudioId prop catches up (or reverted on error).
  const [optimisticSelectedId, setOptimisticSelectedId] = useState<string | null>(null)
  // Tracks the audioId of the most-recently-requested circle so rapid clicks
  // converge: only the last click's outcome updates UI state.
  const latestCircleRef = useRef<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  // Clear optimistic override once the server-confirmed prop catches up.
  useEffect(() => {
    if (optimisticSelectedId !== null && selectedAudioId === optimisticSelectedId) {
      setOptimisticSelectedId(null)
    }
  }, [selectedAudioId, optimisticSelectedId])

  const stopPlayback = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
    setPlayingId(null)
  }, [])

  useEffect(() => () => stopPlayback(), [stopPlayback])

  const play = useCallback(async (att: AudioAttachmentOut) => {
    if (playingId === att.audioId) { stopPlayback(); return }
    stopPlayback()
    setLoadingId(att.audioId)
    try {
      let src = att.url
      const frontier = parseFrontierAudioUrl(att.url)
      if (frontier) {
        if (!session?.jwt) throw new Error("Sign in to play audio")
        const bytes = await fetchCellAudio({
          projectId, fileId, audioId: frontier.audioId, ext: frontier.ext,
          getSyncToken: audioSyncTokenFetcherForSession(session),
        })
        src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/wav" }))
        urlRef.current = src
      }
      const audio = new Audio(src)
      audioRef.current = audio
      audio.onended = () => stopPlayback()
      await audio.play()
      setPlayingId(att.audioId)
    } catch {
      stopPlayback()
    } finally {
      setLoadingId((cur) => (cur === att.audioId ? null : cur))
    }
  }, [playingId, stopPlayback, session, projectId, fileId])

  const circle = useCallback(async (audioId: string) => {
    // Effective selected = optimistic override if in-flight, else server value.
    const effectiveSelected = optimisticSelectedId ?? selectedAudioId
    if (audioId === effectiveSelected) return
    // Optimistic: show selection immediately (user's latest intent wins).
    setOptimisticSelectedId(audioId)
    latestCircleRef.current = audioId
    setBusyId(audioId)
    try {
      await emitCellAudioSelect({ projectId, fileId, cellId, audioId, slot: "recording", author })
      notifyAudioAttachmentsChanged(fileId)
    } catch {
      // Only revert optimistic state if this is still the latest click.
      if (latestCircleRef.current === audioId) {
        setOptimisticSelectedId(null)
      }
    } finally {
      setBusyId((cur) => (cur === audioId ? null : cur))
    }
  }, [optimisticSelectedId, selectedAudioId, projectId, fileId, cellId, author])

  const remove = useCallback(async (audioId: string) => {
    setBusyId(audioId)
    try {
      if (playingId === audioId) stopPlayback()
      await emitCellAudioRemove({ projectId, fileId, cellId, audioId, author })
      notifyAudioAttachmentsChanged(fileId)
    } finally {
      setBusyId((cur) => (cur === audioId ? null : cur))
    }
  }, [playingId, stopPlayback, projectId, fileId, cellId, author])

  // On-device noise removal: clean THIS take into a new (denoised) take. The
  // heavy RNNoise/wasm path is dynamically imported so it's only loaded when a
  // user actually denoises. denoiseTake handles upload + attach + bus poke.
  const [denoisingId, setDenoisingId] = useState<string | null>(null)
  const denoise = useCallback(async (att: AudioAttachmentOut) => {
    if (!session?.jwt || denoisingId) return
    setDenoisingId(att.audioId)
    try {
      const { denoiseTake } = await import("@/lib/audio/denoise-take")
      await denoiseTake({
        projectId, fileId, cellId,
        sourceAudioId: att.audioId,
        sourceUrl: att.url,
        author,
        session,
      })
    } catch {
      // Failure leaves the original untouched; the strip simply doesn't gain a
      // cleaned take. (Inline DenoiseButton surfaces the detailed error.)
    } finally {
      setDenoisingId((cur) => (cur === att.audioId ? null : cur))
    }
  }, [session, denoisingId, projectId, fileId, cellId, author])

  // Cleaned (dn-) takes pinned above originals; originals keep 1-based "Take N"
  // numbering among themselves.
  const ordered = useMemo(() => {
    const byId = (a: AudioAttachmentOut, b: AudioAttachmentOut) => a.audioId.localeCompare(b.audioId)
    const cleaned = takes.filter((t) => isDenoisedAudioId(t.audioId)).sort(byId)
    const originals = takes.filter((t) => !isDenoisedAudioId(t.audioId)).sort(byId)
    const number = new Map<string, number>()
    originals.forEach((t, i) => number.set(t.audioId, i + 1))
    return [...cleaned, ...originals].map((att) => ({
      att,
      isCleaned: isDenoisedAudioId(att.audioId),
      label: isDenoisedAudioId(att.audioId)
        ? t("audio.takesStrip.cleanedLabel")
        : t("audio.takesStrip.takeLabel", { number: number.get(att.audioId) ?? 0 }),
    }))
  }, [takes, t])

  if (takes.length === 0) return null

  const haveTake = new Set(takes.map((t) => t.audioId))

  return (
    <div className="border-t px-5 py-3">
      <div className="mb-2 text-xs text-muted-foreground/60">
        {t("audio.takesStrip.heading", { count: takes.length })}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ordered.map(({ att, isCleaned, label }) => {
          // Use optimistic override while in-flight; fall back to server value.
          const effectiveSelectedId = optimisticSelectedId ?? selectedAudioId
          const isCircled = att.audioId === effectiveSelectedId
          const isPlaying = att.audioId === playingId
          const isLoading = att.audioId === loadingId
          const isBusy = att.audioId === busyId
          // Disable all circle buttons while any selection switch is in flight.
          const isSelectInFlight = busyId !== null
          const isDenoising = att.audioId === denoisingId
          // A cleaned take can revert to the source it was derived from, as long
          // as that take is still present.
          const revertTo = att.referenceAudioId
          const canRevert = isCleaned && !!revertTo && haveTake.has(revertTo)
          return (
            <div
              key={att.audioId}
              className={cn(
                "flex items-center gap-1 rounded-md border py-0.5 pl-1 pr-1.5 text-xs transition-colors",
                isCircled
                  ? "border-emerald-500/60 bg-emerald-500/10"
                  : isCleaned
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-border bg-muted/30",
              )}
            >
              <AppTooltip content={isPlaying ? t("audio.takesStrip.stopTooltip") : t("audio.takesStrip.playTakeTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void play(att)}
                  aria-label={isPlaying ? t("audio.takesStrip.stopTooltip") : t("audio.takesStrip.playTakeTooltip")}
                  className="rounded-md hover:bg-background"
                >
                  {isLoading ? <Spinner className="size-3.5" />
                    : isPlaying ? <Pause className="h-3.5 w-3.5" />
                    : <Play className="h-3.5 w-3.5" />}
                </Button>
              </AppTooltip>
              <span className="inline-flex items-center gap-1 tabular-nums">
                {isCleaned && <Bird className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />}
                {label}
                {att.durationMs != null && (
                  <span className="ml-1 text-muted-foreground/70">{(att.durationMs / 1000).toFixed(1)}s</span>
                )}
              </span>
              {!isCleaned && (
                <AppTooltip content={t("audio.takesStrip.removeNoiseTooltip")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void denoise(att)}
                    disabled={!session?.jwt || denoisingId !== null}
                    aria-label={t("audio.takesStrip.removeNoiseTooltip")}
                    className="rounded-md text-muted-foreground/60 hover:bg-background"
                  >
                    {isDenoising ? <Spinner className="size-3.5" /> : <Bird className="h-3.5 w-3.5" />}
                  </Button>
                </AppTooltip>
              )}
              {canRevert && (
                <AppTooltip content={t("audio.takesStrip.revertTooltip")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void circle(revertTo)}
                    disabled={isSelectInFlight}
                    aria-label={t("audio.takesStrip.revertTooltip")}
                    className="rounded-md text-muted-foreground/60 hover:bg-background"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </AppTooltip>
              )}
              <AppTooltip content={isCircled ? t("audio.takesStrip.activeTakeTooltip") : t("audio.takesStrip.useTakeTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void circle(att.audioId)}
                  disabled={isSelectInFlight || isCircled}
                  aria-label={isCircled ? t("audio.takesStrip.activeTakeTooltip") : t("audio.takesStrip.useTakeTooltip")}
                  className={cn(
                    "rounded-md hover:bg-background",
                    isCircled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/60",
                  )}
                >
                  {isBusy ? <Spinner className="size-3.5" /> : <Check className="h-3.5 w-3.5" />}
                </Button>
              </AppTooltip>
              <AppTooltip content={t("audio.takesStrip.deleteTakeTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void remove(att.audioId)}
                  disabled={isBusy}
                  aria-label={t("audio.takesStrip.deleteTakeTooltip")}
                  className="rounded-md text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </AppTooltip>
            </div>
          )
        })}
      </div>
    </div>
  )
}
