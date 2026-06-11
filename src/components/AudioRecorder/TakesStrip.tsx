// Take management for a single cell's recording slot. Lists every recorded
// take, lets the user audition each, circle the keeper (the active clip in the
// "recording" slot), and delete rejects. Self-contained: resolves frontier
// audio URLs to playable blobs and emits cell.audio.select / cell.audio.remove.

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Loader2, Pause, Play, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import type { FrontierSession } from "@/lib/frontier/types"
import { fetchCellAudio, parseFrontierAudioUrl } from "@/lib/audio/upload"
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

  if (takes.length === 0) return null

  return (
    <div className="border-t px-5 py-3">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
        Takes ({takes.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {takes.map((att, i) => {
          // Use optimistic override while in-flight; fall back to server value.
          const effectiveSelectedId = optimisticSelectedId ?? selectedAudioId
          const isCircled = att.audioId === effectiveSelectedId
          const isPlaying = att.audioId === playingId
          const isLoading = att.audioId === loadingId
          const isBusy = att.audioId === busyId
          // Disable all circle buttons while any selection switch is in flight.
          const isSelectInFlight = busyId !== null
          return (
            <div
              key={att.audioId}
              className={cn(
                "flex items-center gap-1 rounded-full border py-0.5 pl-1 pr-1.5 text-xs transition-colors",
                isCircled ? "border-emerald-500/60 bg-emerald-500/10" : "border-border bg-muted/30",
              )}
            >
              <button
                type="button"
                onClick={() => void play(att)}
                title={isPlaying ? "Stop" : "Play take"}
                className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-background"
              >
                {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : isPlaying ? <Pause className="h-3.5 w-3.5" />
                  : <Play className="h-3.5 w-3.5" />}
              </button>
              <span className="tabular-nums">
                Take {i + 1}
                {att.durationMs != null && (
                  <span className="ml-1 text-muted-foreground/70">{(att.durationMs / 1000).toFixed(1)}s</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => void circle(att.audioId)}
                disabled={isSelectInFlight || isCircled}
                title={isCircled ? "Active take" : "Use this take"}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full",
                  isCircled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/60 hover:bg-background hover:text-foreground",
                )}
              >
                {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => void remove(att.audioId)}
                disabled={isBusy}
                title="Delete take"
                className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
