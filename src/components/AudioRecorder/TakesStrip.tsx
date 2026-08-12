// Take management for a single cell's recording slot: a LIST of rows (round
// 8), one per take — name, length, audition, circle the keeper, delete.
// Names are PERMANENT identities ("Take 3" stays "Take 3" when "Take 2"
// dies; auto-names are placeholders users can rename, persisted via
// cell.audio.rename). Self-contained: resolves frontier audio URLs to
// playable blobs and emits cell.audio.select / .remove / .rename.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bird, Check, CloudUpload, Pause, Pencil, Play, RotateCcw, Sparkles, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import type { FrontierSession } from "@/lib/frontier/types"
import { audioIdSeededWith, fetchCellAudio, isDenoisedAudioId, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { audioMimeForExt } from "@/lib/audio/mime"
import { emitCellAudioSelect, emitCellAudioRemove, emitCellAudioRename } from "@/lib/sync/events-emit"
import {
  injectOptimisticAudioAttachment,
  injectOptimisticAudioRemove,
  notifyAudioAttachmentsChanged,
} from "@/lib/audio/audio-attachments-bus"

/** "Take 7" → 7; anything else → null. */
function parseTakeNumber(label: string | null | undefined): number | null {
  const m = label?.match(/^Take (\d+)$/)
  return m ? Number(m[1]) : null
}

/** The next fresh take name for a cell, given its current takes' labels. */
export function nextTakeLabel(takes: Array<Pick<AudioAttachmentOut, "label">>): string {
  let max = 0
  for (const t of takes) {
    const n = parseTakeNumber(t.label)
    if (n != null && n > max) max = n
  }
  // Unlabeled legacy takes still occupy numbers once backfilled; count them
  // in so a fresh recording never collides with a pending backfill.
  const unlabeled = takes.filter((t) => !t.label).length
  return `Take ${Math.max(max, unlabeled) + 1}`
}

interface Props {
  projectId: string
  fileId: string
  cellId: string
  /** Recorded AND generated (TTS) takes — one list (round 8c). */
  takes: AudioAttachmentOut[]
  /**
   * AQU-646: the LAST take belonging to this cell was just removed. The
   * workspace uses it to reset the target row an earlier take created, so a
   * line does not keep counting as finished work after its recording is gone.
   */
  onLastTakeRemoved?: (cellId: string) => void
  /** RAW recording-slot selection (may be the source clip — not in `takes`). */
  selectedAudioId: string | null
  /** RAW generated-slot selection. */
  selectedGeneratedAudioId?: string | null
  /** The source clip — activating a TTS take hands the recording slot back to
   *  it so the generated audio can sound (playback prefers a recorded take). */
  sourceClip?: AudioAttachmentOut | null
  author: string
  session: FrontierSession | null
}

export function TakesStrip({
  projectId,
  fileId,
  cellId,
  takes,
  onLastTakeRemoved,
  selectedAudioId,
  selectedGeneratedAudioId = null,
  sourceClip = null,
  author,
  session,
}: Props) {
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

  // The take that actually SOUNDS, mirroring playback's preference order: a
  // recorded take holding the recording slot wins; otherwise the selected
  // generated (TTS) take. When the slot holds the source clip (not a take),
  // it falls through to the generated selection.
  const activeTakeId =
    takes.some((t) => t.audioId === selectedAudioId && t.slot === "recording")
      ? selectedAudioId
      : (selectedGeneratedAudioId ?? null)

  // Clear optimistic override once the server-confirmed prop catches up.
  useEffect(() => {
    if (optimisticSelectedId !== null && activeTakeId === optimisticSelectedId) {
      setOptimisticSelectedId(null)
    }
  }, [activeTakeId, optimisticSelectedId])

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
        // Fortify pass: type the blob by its REAL container (takes are webm,
        // generations may be webm/opus or wav) — Safari/Firefox trust the
        // declared type and reject mislabeled bytes with a bare onerror.
        src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: audioMimeForExt(frontier.ext) }))
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
    const effectiveSelected = optimisticSelectedId ?? activeTakeId
    if (audioId === effectiveSelected) return
    // Optimistic: show selection immediately (user's latest intent wins).
    setOptimisticSelectedId(audioId)
    latestCircleRef.current = audioId
    setBusyId(audioId)
    // Round 7 (SUB-39): push the selection through the optimistic attachment
    // bus too — the merged cells flip the selection (with the take's real
    // durationMs/trims) instantly, so the timeline chip swaps and resizes with
    // zero round-trip. Previously only this strip's local checkmark moved.
    // SUB-48: the overlay is handed the emit PROMISE, so it paints now and
    // stays alive for exactly as long as its event sits in the outbox.
    const take = takes.find((t) => t.audioId === audioId)
    const slot = take?.slot === "generatedVoice" ? "generatedVoice" : "recording"
    // Round 8c: a generated take only sounds when no recorded take holds the
    // recording slot — hand that slot back to the source clip alongside.
    const displaceToSource =
      slot === "generatedVoice" &&
      sourceClip != null &&
      takes.some((t) => t.audioId === selectedAudioId && t.slot === "recording")
    try {
      const selectP = emitCellAudioSelect({ projectId, fileId, cellId, audioId, slot, author })
      if (take) injectOptimisticAudioAttachment(fileId, cellId, take, selectP)
      await selectP
      if (displaceToSource) {
        const displaceP = emitCellAudioSelect({
          projectId, fileId, cellId, audioId: sourceClip.audioId, slot: "recording", author,
        })
        injectOptimisticAudioAttachment(fileId, cellId, sourceClip, displaceP)
        await displaceP
      }
      notifyAudioAttachmentsChanged(fileId)
    } catch {
      // Only revert optimistic state if this is still the latest click.
      if (latestCircleRef.current === audioId) {
        setOptimisticSelectedId(null)
      }
    } finally {
      setBusyId((cur) => (cur === audioId ? null : cur))
    }
  }, [optimisticSelectedId, activeTakeId, selectedAudioId, sourceClip, takes, projectId, fileId, cellId, author])

  const remove = useCallback(async (audioId: string) => {
    setBusyId(audioId)
    try {
      if (playingId === audioId) stopPlayback()
      // SUB-48: deletes get their own overlay. Without it the take stayed on
      // screen while its remove sat in the outbox — reading as "it won't
      // delete" — and any still-queued attach for the same clip painted it
      // back (injectOptimisticAudioRemove cancels that attach outright).
      const slot = takes.find((t) => t.audioId === audioId)?.slot === "generatedVoice"
        ? "generatedVoice"
        : "recording"
      const removeP = emitCellAudioRemove({ projectId, fileId, cellId, audioId, author })
      injectOptimisticAudioRemove(fileId, cellId, audioId, slot, removeP)
      await removeP
      notifyAudioAttachmentsChanged(fileId)
      // Was that the cell's last recording? `takes` still holds the pre-removal
      // list, so the survivors are everything else that is a take OF THIS CELL
      // — `audioIdSeededWith` keeps the shared imported source clip, which is
      // seeded with the file's id, from counting as one.
      const ownTakesLeft = takes.filter(
        (t) => t.audioId !== audioId && t.slot !== "generatedVoice" && audioIdSeededWith(t.audioId, cellId),
      )
      if (ownTakesLeft.length === 0) onLastTakeRemoved?.(cellId)
    } catch {
      // The overlay drops itself on rejection and pokes a refetch, so the row
      // reappears from server truth rather than the UI wedging.
    } finally {
      setBusyId((cur) => (cur === audioId ? null : cur))
    }
  }, [playingId, stopPlayback, takes, projectId, fileId, cellId, author, onLastTakeRemoved])

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

  // Round 8: names are PERSISTED (att.label) — never derived from position.
  // Strip-local overrides show a rename/backfill instantly (a bus inject
  // would also flip selection — attach semantics — so renames stay local
  // until the server read confirms).
  const [labelOverrides, setLabelOverrides] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    setLabelOverrides((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      let changed = false
      for (const t of takes) {
        const o = next.get(t.audioId)
        if (o != null && t.label === o) {
          next.delete(t.audioId)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [takes])
  const displayLabel = useCallback(
    (att: AudioAttachmentOut): string =>
      labelOverrides.get(att.audioId) ??
      att.label ??
      (isDenoisedAudioId(att.audioId) ? "Cleaned" : "Take"),
    [labelOverrides],
  )

  // Inline rename (pencil → input; Enter/blur commits, Esc cancels).
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  const commitRename = useCallback(
    async (att: AudioAttachmentOut) => {
      const label = renameDraft.trim()
      setRenamingId(null)
      if (!label || label === displayLabel(att)) return
      setLabelOverrides((prev) => new Map(prev).set(att.audioId, label))
      try {
        await emitCellAudioRename({ projectId, fileId, cellId, audioId: att.audioId, label, author })
        notifyAudioAttachmentsChanged(fileId)
      } catch {
        setLabelOverrides((prev) => {
          const next = new Map(prev)
          next.delete(att.audioId)
          return next
        })
      }
    },
    [renameDraft, displayLabel, projectId, fileId, cellId, author],
  )

  // Legacy takes recorded before labels existed: backfill "Take N" ONCE (by
  // the takes' stable id/order), after which every name is permanent.
  const backfilledRef = useRef(false)
  useEffect(() => {
    if (backfilledRef.current || !session?.jwt) return
    const unlabeled = takes.filter((t) => !t.label && !isDenoisedAudioId(t.audioId) && !labelOverrides.has(t.audioId))
    if (unlabeled.length === 0) return
    backfilledRef.current = true
    let n = 0
    for (const t of takes) {
      const parsed = parseTakeNumber(t.label)
      if (parsed != null && parsed > n) n = parsed
    }
    const sorted = [...unlabeled].sort((a, b) => a.audioId.localeCompare(b.audioId))
    void (async () => {
      for (const t of sorted) {
        n += 1
        const label = `Take ${n}`
        setLabelOverrides((prev) => new Map(prev).set(t.audioId, label))
        try {
          await emitCellAudioRename({ projectId, fileId, cellId, audioId: t.audioId, label, author })
        } catch {
          /* backfill is best-effort; next mount retries */
        }
      }
      notifyAudioAttachmentsChanged(fileId)
    })()
  }, [takes, session?.jwt, labelOverrides, projectId, fileId, cellId, author])

  // Cleaned (dn-) takes pinned above originals; stable id order within groups.
  const ordered = useMemo(() => {
    const byId = (a: AudioAttachmentOut, b: AudioAttachmentOut) => a.audioId.localeCompare(b.audioId)
    const cleaned = takes.filter((t) => isDenoisedAudioId(t.audioId)).sort(byId)
    const originals = takes.filter((t) => !isDenoisedAudioId(t.audioId)).sort(byId)
    return [...cleaned, ...originals].map((att) => ({
      att,
      isCleaned: isDenoisedAudioId(att.audioId),
    }))
  }, [takes])

  if (takes.length === 0) return null

  const haveTake = new Set(takes.map((t) => t.audioId))

  return (
    <div className="border-t px-5 py-3">
      <div className="mb-2 text-xs text-muted-foreground/60">
        Takes ({takes.length})
      </div>
      {/* Round 8: rows, not chips — one take per line, name first. */}
      <div className="flex flex-col gap-1">
        {ordered.map(({ att, isCleaned }) => {
          // Use optimistic override while in-flight; fall back to server value.
          const effectiveSelectedId = optimisticSelectedId ?? activeTakeId
          const isCircled = att.audioId === effectiveSelectedId
          const isGenerated = att.slot === "generatedVoice"
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
              data-testid={`take-row-${att.audioId}`}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md border px-1.5 py-1 text-xs transition-colors",
                isCircled
                  ? isGenerated
                    ? "border-violet-500/60 bg-violet-500/10"
                    : "border-emerald-500/60 bg-emerald-500/10"
                  : isCleaned
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-border bg-muted/30",
              )}
            >
              <AppTooltip content={isPlaying ? "Stop" : "Play take"}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void play(att)}
                  aria-label={isPlaying ? "Stop" : "Play take"}
                  className="rounded-md hover:bg-background"
                >
                  {isLoading ? <Spinner className="size-3.5" />
                    : isPlaying ? <Pause className="h-3.5 w-3.5" />
                    : <Play className="h-3.5 w-3.5" />}
                </Button>
              </AppTooltip>
              <span className="flex min-w-0 flex-1 items-center gap-1 tabular-nums">
                {isCleaned && <Bird className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                {isGenerated && <Sparkles className="h-3 w-3 shrink-0 text-violet-600 dark:text-violet-400" />}
                {renamingId === att.audioId ? (
                  <input
                    autoFocus
                    data-testid={`take-rename-${att.audioId}`}
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => void commitRename(att)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        void commitRename(att)
                      } else if (e.key === "Escape") {
                        setRenamingId(null)
                      }
                    }}
                    className="w-full min-w-0 rounded border border-border bg-background px-1 py-0.5 text-xs"
                  />
                ) : (
                  <>
                    <span data-testid={`take-label-${att.audioId}`} className="truncate font-medium">
                      {displayLabel(att)}
                    </span>
                    {att.durationMs != null ? (
                      <span className="shrink-0 text-muted-foreground/70">{(att.durationMs / 1000).toFixed(1)}s</span>
                    ) : (
                      // SUB-48: no measured length. Say so — a blank space read
                      // as "fine" while the chip was quietly section-width.
                      <span
                        title="Length unknown — re-record or re-upload to fix"
                        data-testid={`take-unknown-length-${att.audioId}`}
                        className="shrink-0 text-muted-foreground/50"
                      >
                        ?
                      </span>
                    )}
                    {att.pendingSync && (
                      <span
                        title="Saving — kept safe on this device until it syncs"
                        data-testid={`take-saving-${att.audioId}`}
                        className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground/70"
                      >
                        <CloudUpload className="h-3 w-3 animate-pulse" /> saving…
                      </span>
                    )}
                    <AppTooltip content="Rename take">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => {
                          setRenameDraft(displayLabel(att))
                          setRenamingId(att.audioId)
                        }}
                        aria-label="Rename take"
                        className="rounded-md text-muted-foreground/40 hover:bg-background hover:text-foreground"
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    </AppTooltip>
                  </>
                )}
              </span>
              {!isCleaned && !isGenerated && (
                <AppTooltip content="Remove noise (adds a cleaned take)">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void denoise(att)}
                    disabled={!session?.jwt || denoisingId !== null}
                    aria-label="Remove noise (adds a cleaned take)"
                    className="rounded-md text-muted-foreground/60 hover:bg-background"
                  >
                    {isDenoising ? <Spinner className="size-3.5" /> : <Bird className="h-3.5 w-3.5" />}
                  </Button>
                </AppTooltip>
              )}
              {canRevert && (
                <AppTooltip content="Revert to the original recording">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void circle(revertTo)}
                    disabled={isSelectInFlight}
                    aria-label="Revert to the original recording"
                    className="rounded-md text-muted-foreground/60 hover:bg-background"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </AppTooltip>
              )}
              <AppTooltip content={isCircled ? "Active take" : "Use this take"}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void circle(att.audioId)}
                  disabled={isSelectInFlight || isCircled}
                  aria-label={isCircled ? "Active take" : "Use this take"}
                  className={cn(
                    "rounded-md hover:bg-background",
                    isCircled
                      ? isGenerated
                        ? "text-violet-600 dark:text-violet-400"
                        : "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground/60",
                  )}
                >
                  {isBusy ? <Spinner className="size-3.5" /> : <Check className="h-3.5 w-3.5" />}
                </Button>
              </AppTooltip>
              <AppTooltip content="Delete take">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void remove(att.audioId)}
                  disabled={isBusy}
                  aria-label="Delete take"
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
