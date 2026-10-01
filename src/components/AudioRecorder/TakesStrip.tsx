// Take management for a single cell's recording slot: a LIST of rows (round
// 8), one per take — name, length, audition, circle the keeper, delete.
// Names are PERMANENT identities ("Take 3" stays "Take 3" when "Take 2"
// dies; auto-names are placeholders users can rename, persisted via
// cell.audio.rename). Self-contained: resolves frontier audio URLs to
// playable blobs and emits cell.audio.select / .remove / .rename.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bird, Check, CloudAlert, CloudUpload, FileClock, Pause, Pencil, Play, RotateCcw, Sparkles, Trash2 } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import { GENERATED_VOICE_SLOT, RECORDING_SLOT } from "@/lib/timeline/track-slots"
import type { FrontierSession } from "@/lib/frontier/types"
import { fetchCellAudio, isDenoisedAudioId, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { audioMimeForExt } from "@/lib/audio/mime"
import { claimActiveAudio, clearActiveAudioIf, type ActiveAudioController } from "@/lib/audio/audio-coordinator"
import { emitCellAudioDeselect, emitCellAudioSelect, emitCellAudioRename } from "@/lib/sync/events-emit"
import {
  injectOptimisticAudioAttachment,
  injectOptimisticAudioDeselect,
  notifyAudioAttachmentsChanged,
  retryFailedAudioSync,
} from "@/lib/audio/audio-attachments-bus"
import { hasOwnRecordingLeft, removeTake, renameTake } from "@/lib/audio/take-actions"
import { useRecordingTextDrift } from "@/hooks/useRecordingTextDrift"
import type { RecordingTextDrift } from "@/lib/audio/text-drift"
import { transcriptVerdict } from "@/lib/audio/transcript-verdict"
import { takeTrackVars } from "@/lib/timeline/take-colors"
import { effectiveAttachmentDurationMs } from "@/lib/timeline/lane-timing"
import { TakeRowWave } from "@/components/audio/TakeRowWave"
import { TakeTextVerdict } from "@/components/audio/TakeTextVerdict"
import type { ProjectRecord } from "@/lib/parsers/types"
import { AudioValidationControl } from "@/components/cell/AudioValidationControl"
import { useAudioValidation } from "@/hooks/useAudioValidation"

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
  /**
   * AQU-490: the project record, for the audio validation control beside each
   * take's keeper circle. Required rather than optional on purpose — this
   * strip IS the place a reviewer signs a take off, and an optional prop one
   * call site forgot would simply mean no control there, silently.
   */
  project: ProjectRecord
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
  /** Rows only: no border, no "Takes (N)" heading, tighter padding. The
   *  recorder's utility strip owns that chrome and the count, so the two
   *  cannot say the same thing twice. */
  chromeless?: boolean
  /** AQU-1462: lane the member is working in. Omitted for the default lane. */
  targetLang?: string
  /**
   * "tab": the expanded cell's Recording tab lists a line's OTHER takes with
   * this (Sam, 2026-09-29) — the take that plays is drawn above the list, so
   * `hide` leaves it out. Each row gains the take's shape and how it compares
   * with the text. Rename, remove noise, revert and delete stay on every row,
   * as in the recorder (Sam, 2026-09-29: not hover-only).
   * Selecting, renaming, deleting and cleaning are this component's, exactly
   * as in the recorder.
   */
  variant?: "recorder" | "tab"
  /** Takes to leave out of the list (the tab's playing take). */
  hide?: readonly string[]
  /** Tab: each take's word timings, for how it compares with the text. */
  timingsFor?: (audioId: string) => ReadonlyArray<{ word: string; end: number }> | null | undefined
  /** The file whose timeline these takes are on, for their tracks' colours:
   *  `fileId` itself, except for a heard line's takes, whose tracks are the
   *  subtitle file's while they live in its hidden cue sibling. */
  trackFileId?: string
  /** Tab: the text those timings are compared with, or null when nothing
   *  can say what the takes should say (a part of a split line). */
  cellText?: string | null
  /** The cell's take history, when the caller already read it — the tab reads
   *  it once for the playing take and this list together. */
  history?: ReadonlyMap<string, RecordingTextDrift>
  /**
   * Nothing here may change a take: no choosing, renaming, cleaning,
   * reverting or deleting — play only. The recorder only ever opens for
   * someone who can edit; the Recording tab shows this list to everyone, and
   * a viewer's press would paint a change the server then refuses (found
   * 2026-09-29, walking the tab as a viewer).
   */
  readOnly?: boolean
}

export function TakesStrip({
  projectId,
  project,
  fileId,
  cellId,
  takes,
  onLastTakeRemoved,
  selectedAudioId,
  selectedGeneratedAudioId = null,
  sourceClip = null,
  author,
  session,
  chromeless = false,
  targetLang,
  variant = "recorder",
  hide,
  timingsFor,
  cellText = "",
  trackFileId,
  history,
  readOnly = false,
}: Props) {
  const tab = variant === "tab"
  const t = useT()
  const audioValidation = useAudioValidation({
    project, fileId, cellId, username: author, jwt: session?.jwt ?? null,
    ...(targetLang ? { targetLang } : {}),
  })
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

  // One history read per cell answers two questions about every take on it:
  //
  //   AQU-464  — was this take recorded against text that has since been
  //              re-worded? Recorded takes only; a generated (TTS) take is
  //              synthesised FROM the current text, so it cannot lag it and
  //              flagging one would be noise. That filter now lives at the
  //              BADGE (`isGenerated` below) rather than in the id list.
  //   AQU-1372 — when was it made, and by whom? True of every take, generated
  //              ones included, so the list asked for must be all of them.
  //
  // Widening the id list is what lets one read serve both: resolving the whole
  // cell costs no extra request, and a second hook for provenance would have
  // doubled the history read on the hottest strip in the editor.
  const allTakeIds = useMemo(() => takes.map((t) => t.audioId), [takes])
  const driftTokenFetcher = useMemo(() => audioSyncTokenFetcherForSession(session), [session])
  const ownHistory = useRecordingTextDrift({
    enabled: !history && Boolean(session?.jwt) && allTakeIds.length > 0,
    projectId,
    fileId,
    cellId,
    audioIds: allTakeIds,
    getTokenForFile: driftTokenFetcher,
  })
  const takeHistory = history ?? ownHistory

  // The take that actually SOUNDS, mirroring playback's preference order: a
  // recorded take holding the recording slot wins; otherwise the selected
  // generated (TTS) take. When the slot holds the source clip (not a take),
  // it falls through to the generated selection.
  // AQU-646 stage 3: SLOT-AGNOSTIC. The old form required the take to be in
  // the literal "recording" slot, so an added track's take — whose slot is the
  // track's own id — never matched and the strip highlighted nothing. The
  // default row is unaffected: its source clip is not in `takes`, so a
  // selection pointing at it still falls through to the generated pointer,
  // which is the behaviour that has always shipped.
  const activeTakeId =
    takes.some((t) => t.audioId === selectedAudioId)
      ? selectedAudioId
      : (selectedGeneratedAudioId ?? null)

  // Clear optimistic override once the server-confirmed prop catches up.
  useEffect(() => {
    if (optimisticSelectedId !== null && activeTakeId === optimisticSelectedId) {
      setOptimisticSelectedId(null)
    }
  }, [activeTakeId, optimisticSelectedId])

  // AQU-1217: one sound at a time. An audition registers with the audio
  // coordinator, so starting the recorder's selected-take waveform silences it
  // and starting an audition silences the waveform. Built on first use, inside
  // a callback — never read during render.
  const auditionRef = useRef<ActiveAudioController | null>(null)

  const stopPlayback = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
    if (auditionRef.current) clearActiveAudioIf(auditionRef.current)
    setPlayingId(null)
  }, [])

  const audition = useCallback((): ActiveAudioController => {
    if (!auditionRef.current) {
      auditionRef.current = {
        isPlaying: () => Boolean(audioRef.current && !audioRef.current.paused),
        play: async () => {},
        pause: () => stopPlayback(),
      }
    }
    return auditionRef.current
  }, [stopPlayback])

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
      claimActiveAudio(audition())
      await audio.play()
      setPlayingId(att.audioId)
    } catch {
      stopPlayback()
    } finally {
      setLoadingId((cur) => (cur === att.audioId ? null : cur))
    }
  }, [playingId, stopPlayback, audition, session, projectId, fileId])

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
    // THE TAKE'S OWN SLOT, VERBATIM. (AQU-646 stage 3)
    //
    // This used to be a binary coercion — anything that was not
    // `"generatedVoice"` became `"recording"` — which was right while those
    // were the only two slots and is a DATA-MOVER now: a take on an added
    // track would be selected into the default row's slot, and the
    // per-(cell, slot) deselect would drop whatever was really there.
    const slot = take?.slot ?? RECORDING_SLOT
    // Round 8c: a generated take only sounds when no recorded take holds the
    // recording slot — hand that slot back to the source clip alongside, or,
    // with no source clip to park it on (every text file), empty it: that case
    // used to do nothing, and the recording kept playing (Sam, 2026-09-28).
    //
    // THE DEFAULT TRACK ONLY. An added track has one slot holding both kinds,
    // so picking either already deselects the other.
    const displaceRecording =
      slot === GENERATED_VOICE_SLOT &&
      takes.some((t) => t.audioId === selectedAudioId && t.slot === RECORDING_SLOT)
    try {
      const selectP = emitCellAudioSelect({
        projectId, fileId, cellId, audioId, slot, author,
        ...(targetLang ? { targetLang } : {}),
      })
      if (take) injectOptimisticAudioAttachment(fileId, cellId, take, selectP)
      await selectP
      if (displaceRecording) {
        const where = { projectId, fileId, cellId, slot: RECORDING_SLOT, author, ...(targetLang ? { targetLang } : {}) }
        const displaceP = sourceClip
          ? emitCellAudioSelect({ ...where, audioId: sourceClip.audioId })
          : emitCellAudioDeselect(where)
        if (sourceClip) injectOptimisticAudioAttachment(fileId, cellId, sourceClip, displaceP)
        else injectOptimisticAudioDeselect(fileId, cellId, RECORDING_SLOT, displaceP)
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
  }, [optimisticSelectedId, activeTakeId, selectedAudioId, sourceClip, takes, projectId, fileId, cellId, author, targetLang])

  const remove = useCallback(async (audioId: string) => {
    setBusyId(audioId)
    try {
      if (playingId === audioId) stopPlayback()
      // The take's own slot, verbatim — see the note in `circle` above for why
      // the old binary coercion became a data-mover once a take could belong
      // to an added track.
      const slot = takes.find((t) => t.audioId === audioId)?.slot ?? RECORDING_SLOT
      await removeTake({ projectId, fileId, cellId, audioId, slot, author, ...(targetLang ? { targetLang } : {}) })
      // Was that the cell's last recording? `takes` still holds the pre-removal
      // list, so the survivors are everything else that is a take OF THIS CELL.
      if (!hasOwnRecordingLeft(takes, audioId, cellId)) onLastTakeRemoved?.(cellId)
    } catch {
      // The overlay drops itself on rejection and pokes a refetch, so the row
      // reappears from server truth rather than the UI wedging.
    } finally {
      setBusyId((cur) => (cur === audioId ? null : cur))
    }
  }, [playingId, stopPlayback, takes, projectId, fileId, cellId, author, onLastTakeRemoved, targetLang])

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
        ...(targetLang ? { targetLang } : {}),
      })
    } catch {
      // Failure leaves the original untouched; the strip simply doesn't gain a
      // cleaned take. (Inline DenoiseButton surfaces the detailed error.)
    } finally {
      setDenoisingId((cur) => (cur === att.audioId ? null : cur))
    }
  }, [session, denoisingId, projectId, fileId, cellId, author, targetLang])

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
      // A stored name is user data — never translated. Only the placeholder
      // shown until a name exists (or is backfilled) is a UI string.
      att.label ??
      (isDenoisedAudioId(att.audioId)
        ? t("audio.takesStrip.cleanedLabel")
        : t("audio.takesStrip.takeFallback")),
    [labelOverrides, t],
  )

  // Inline rename (pencil → input; Enter/blur commits, Esc cancels).
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  // Escape closes the box, and a closing box loses focus — whose handler
  // would then save what Escape meant to throw away.
  const renameCancelledRef = useRef(false)
  const commitRename = useCallback(
    async (att: AudioAttachmentOut) => {
      const label = renameDraft.trim()
      setRenamingId(null)
      if (renameCancelledRef.current) { renameCancelledRef.current = false; return }
      if (!label || label === displayLabel(att)) return
      setLabelOverrides((prev) => new Map(prev).set(att.audioId, label))
      try {
        await renameTake({ projectId, fileId, cellId, audioId: att.audioId, label, author, ...(targetLang ? { targetLang } : {}) })
      } catch {
        setLabelOverrides((prev) => {
          const next = new Map(prev)
          next.delete(att.audioId)
          return next
        })
      }
    },
    [renameDraft, displayLabel, projectId, fileId, cellId, author, targetLang],
  )

  // Legacy takes recorded before labels existed: backfill "Take N" ONCE (by
  // the takes' stable id/order), after which every name is permanent.
  const backfilledRef = useRef(false)
  useEffect(() => {
    // Not for someone who may not rename: every backfilled name would be
    // refused by the server.
    if (backfilledRef.current || !session?.jwt || readOnly) return
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
          await emitCellAudioRename({
            projectId, fileId, cellId, audioId: t.audioId, label, author,
            ...(targetLang ? { targetLang } : {}),
          })
        } catch {
          /* backfill is best-effort; next mount retries */
        }
      }
      notifyAudioAttachmentsChanged(fileId)
    })()
  }, [takes, session?.jwt, labelOverrides, projectId, fileId, cellId, author, targetLang, readOnly])

  // Cleaned (dn-) takes pinned above originals; stable id order within groups.
  const ordered = useMemo(() => {
    const byId = (a: AudioAttachmentOut, b: AudioAttachmentOut) => a.audioId.localeCompare(b.audioId)
    const listed = hide?.length ? takes.filter((t) => !hide.includes(t.audioId)) : takes
    const cleaned = listed.filter((t) => isDenoisedAudioId(t.audioId)).sort(byId)
    const originals = listed.filter((t) => !isDenoisedAudioId(t.audioId)).sort(byId)
    return [...cleaned, ...originals].map((att) => ({
      att,
      isCleaned: isDenoisedAudioId(att.audioId),
    }))
  }, [takes, hide])

  if (ordered.length === 0) return null

  const haveTake = new Set(takes.map((t) => t.audioId))

  return (
    <div className={tab ? "flex flex-col gap-1" : chromeless ? "px-4 py-2" : "border-t px-5 py-3"} data-testid={tab ? "tab-other-takes" : undefined}>
      {tab && (
        <div className="text-[11px] font-medium text-muted-foreground">
          {t("editor.recordingTab.otherTakes", { count: ordered.length })}
        </div>
      )}
      {/* The recorder's utility strip carries the count and the border itself,
          so inside it this component renders rows and nothing else — two
          "Takes (3)" headings three inches apart is the failure this avoids. */}
      {!chromeless && !tab && (
        <div className="mb-2 text-xs text-muted-foreground/60">
          {t("audio.takesStrip.heading", { count: takes.length })}
        </div>
      )}
      {/* Round 8: rows, not chips — one take per line, name first.
          The strip does NOT cap or scroll itself: its container does. In the
          narrow recorder it is a drawer filling the column's lower half; beside
          a film it is a disclosure raised over the column. Both own a height
          this component cannot know, and a second cap in here would fight
          whichever one it is inside. */}
      <div className="flex flex-col gap-1">
        {ordered.map(({ att, isCleaned }) => {
          // Use optimistic override while in-flight; fall back to server value.
          const effectiveSelectedId = optimisticSelectedId ?? activeTakeId
          const isCircled = att.audioId === effectiveSelectedId
            // AQU-646 stage 3: synthetic-ness comes off the TAKE, not off its slot —
    // an added track's single slot holds both kinds. `voiceId` is set by all
    // three paths that mint a generated voice.
    const isGenerated = Boolean(att.voiceId) || att.slot === GENERATED_VOICE_SLOT
          // AQU-1372: when this take was made and who made it. Absent — never
          // guessed — while the history read is still in flight, or when the
          // 200-event window does not reach back to this take's attach.
          const provenance = takeHistory.get(att.audioId) ?? null
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
                "group/take flex w-full items-center gap-1.5 rounded-md border px-1.5 py-1 text-xs transition-colors",
                isCircled
                  ? isGenerated
                    ? "border-violet-500/60 bg-violet-500/10"
                    : "border-emerald-500/60 bg-emerald-500/10"
                  : isCleaned
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : tab ? "border-border bg-background hover:bg-muted/40" : "border-border bg-muted/30",
              )}
            >
              <AppTooltip content={isPlaying ? t("common.stop") : t("audio.takesStrip.playTakeTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void play(att)}
                  aria-label={isPlaying ? t("common.stop") : t("audio.takesStrip.playTakeTooltip")}
                  className="rounded-md hover:bg-background"
                >
                  {isLoading ? <Spinner className="size-3.5" />
                    : isPlaying ? <Pause className="h-3.5 w-3.5" />
                    : <Play className="h-3.5 w-3.5" />}
                </Button>
              </AppTooltip>
              {tab && (
                <TakeRowWave
                  projectId={projectId}
                  fileId={fileId}
                  att={att}
                  session={session}
                  strategy={project.audioMediaStrategy}
                  generated={isGenerated}
                  trackVars={takeTrackVars({ files: project.files, fileId: trackFileId ?? fileId, slot: att.slot })}
                />
              )}
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
                        renameCancelledRef.current = true
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
                      // The length that plays: a trimmed take's kept part
                      // (AQU-1217), as the chip and the take on top say it.
                      <span data-testid={`take-length-${att.audioId}`} className="shrink-0 text-muted-foreground/70">
                        {((effectiveAttachmentDurationMs({
                          durationMs: att.durationMs,
                          trimStartMs: att.trimStartMs ?? undefined,
                          trimEndMs: att.trimEndMs ?? undefined,
                        }) ?? att.durationMs) / 1000).toFixed(1)}s
                      </span>
                    ) : (
                      // SUB-48: no measured length. Say so — a blank space read
                      // as "fine" while the chip was quietly section-width.
                      <span
                        title={t("audio.takesStrip.unknownLengthTooltip")}
                        data-testid={`take-unknown-length-${att.audioId}`}
                        className="shrink-0 text-muted-foreground/50"
                      >
                        ?
                      </span>
                    )}
                    {att.pendingSync && (
                      <span
                        title={t("audio.takesStrip.pendingSyncTooltip")}
                        data-testid={`take-saving-${att.audioId}`}
                        className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground/70"
                      >
                        <CloudUpload className="h-3 w-3 animate-pulse" /> {t("common.saving")}
                      </span>
                    )}
                    {/* AQU-924: this take never reached the server. Say so ON the
                        take and offer the retry here — it used to just vanish. */}
                    {att.syncFailed && (
                      <button
                        type="button"
                        title={t("audio.takesStrip.syncFailedTooltip")}
                        data-testid={`take-sync-failed-${att.audioId}`}
                        onClick={() => {
                          void retryFailedAudioSync(projectId, fileId, cellId, att.audioId)
                        }}
                        className="flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] text-destructive hover:bg-destructive/10"
                      >
                        <CloudAlert className="h-3 w-3" /> {t("audio.takesStrip.syncFailedRetry")}
                      </button>
                    )}
                    {/* AQU-1372: "recorded when, by whom" — the answer the
                        event log already holds, on the row that asks it.
                        Compact by necessity (this row is dense): the date and
                        the person inline, the exact time in the tooltip. */}
                    {provenance && (
                      <span
                        data-testid={`take-recorded-${att.audioId}`}
                        title={t(
                          isGenerated
                            ? "audio.takesStrip.generatedByTooltip"
                            : "audio.takesStrip.recordedByTooltip",
                          {
                            datetime: new Date(provenance.recordedAt).toLocaleString(),
                            author: provenance.recordedBy,
                          },
                        )}
                        className="min-w-0 shrink truncate text-[10px] text-muted-foreground/60"
                      >
                        {t("audio.takesStrip.recordedByBadge", {
                          date: new Date(provenance.recordedAt).toLocaleDateString(),
                          author: provenance.recordedBy,
                        })}
                      </span>
                    )}
                    {/* AQU-464: this take speaks wording the line no longer
                        carries. Advisory, not an error — reviewing audio
                        against its own older text is the point.

                        AQU-1372: `!isGenerated` is the filter that used to be
                        the hook's id list. A synthesised take is made FROM the
                        current text, so it can never lag it — without this
                        guard, widening that list to every take would have
                        started badging TTS takes as stale. */}
                    {!isGenerated && provenance?.drifted && (
                      <span
                        title={t("audio.takesStrip.textDriftTooltip", {
                          date: new Date(provenance.recordedAt).toLocaleDateString(),
                          text: provenance.textAtRecording ?? "",
                        })}
                        data-testid={`take-text-drift-${att.audioId}`}
                        className="flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] text-amber-700 dark:text-amber-400"
                      >
                        <FileClock className="h-3 w-3" /> {t("audio.takesStrip.textDriftBadge")}
                      </span>
                    )}
                    {/* The tab's question about every take: does it say the
                        text? A generated take is read FROM the text, so only
                        a recording is asked. */}
                    {tab && !isGenerated && (
                      <TakeTextVerdict
                        verdict={transcriptVerdict({ timings: timingsFor?.(att.audioId), cellText })}
                        testId={`take-verdict-${att.audioId}`}
                      />
                    )}
                    <AppTooltip content={t("audio.takesStrip.renameTooltip")}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => {
                          renameCancelledRef.current = false
                          setRenameDraft(displayLabel(att))
                          setRenamingId(att.audioId)
                        }}
                        aria-label={t("audio.takesStrip.renameTooltip")}
                        disabled={readOnly}
                        className={"rounded-md text-muted-foreground/40 hover:bg-background hover:text-foreground"}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    </AppTooltip>
                  </>
                )}
              </span>
              {!isCleaned && !isGenerated && (
                <AppTooltip content={t("audio.takesStrip.removeNoiseTooltip")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void denoise(att)}
                    disabled={readOnly || !session?.jwt || denoisingId !== null}
                    aria-label={t("audio.takesStrip.removeNoiseTooltip")}
                    className={"rounded-md text-muted-foreground/60 hover:bg-background"}
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
                    disabled={readOnly || isSelectInFlight}
                    aria-label={t("audio.takesStrip.revertTooltip")}
                    className={"rounded-md text-muted-foreground/60 hover:bg-background"}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </AppTooltip>
              )}
              {/* AQU-490. On EVERY take, not only the circled one — Sam's
                  call, 2026-09-22. Validation is a property of the take, not
                  of the circle: a vote stays on a take you switch away from
                  and comes back into force if you switch back, and this list
                  is exactly where you compare takes to choose the keeper, so
                  "that older one was signed off by two people" is part of
                  the choice. Showing it on the circled take alone made it
                  look as though validation belonged to the selection.
                  A VOTE ONLY ON THE CIRCLED TAKE (Sam, 2026-09-29 and -30):
                  a vote is cast only on the take that plays for the line,
                  where it can be heard, so every other take shows its
                  validation read-only. In the Recording tab's lists nothing
                  is circled — the take that plays sits above them, with its
                  own vote. */}
              <AudioValidationControl
                  readOnly={readOnly || tab || !isCircled}
                  cellRef={cellId}
                  takes={audioValidation.takeFor(
                    { attachments: { [att.audioId]: att }, selectedBySlot: { [att.slot]: att.audioId } },
                    att.audioId,
                  )}
                  currentUsername={author}
                  validationRequirement={audioValidation.validationRequirement}
                  canValidate={audioValidation.canValidate}
                  onValidationChange={audioValidation.onValidationChange}
                  variant="inline"
                />
              <AppTooltip content={isCircled ? t("audio.takesStrip.activeTakeTooltip") : t("audio.takesStrip.useTakeTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void circle(att.audioId)}
                  disabled={readOnly || isSelectInFlight || isCircled}
                  aria-label={isCircled ? t("audio.takesStrip.activeTakeTooltip") : t("audio.takesStrip.useTakeTooltip")}
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
              <AppTooltip content={t("audio.takesStrip.deleteTakeTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void remove(att.audioId)}
                  disabled={readOnly || isBusy}
                  aria-label={t("audio.takesStrip.deleteTakeTooltip")}
                  className={"rounded-md text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive"}
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
