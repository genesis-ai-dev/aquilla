// Full-screen recording dialog. States: idle → counting → recording →
// preview → uploading → saved. Next/Prev cell navigation lives in the footer
// and in arrow-key shortcuts. Space toggles start/stop; Esc smartly
// cancels/closes based on current phase.
//
// This deliberately owns its own recorder + upload — the per-cell inline
// "capture-and-save" hook is not reused here because the modal adds a
// preview/retake step between stop and upload.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, ChevronsRight, Mic, Pin, Play, Sparkles, Square, X, Volume2, VolumeX, RefreshCw, Check } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useAudioRecorder } from "@/hooks/useAudioRecorder"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOnline } from "@/hooks/useOnline"
import { pushAudioShortcutOverride } from "@/lib/audio/audio-coordinator"
import { probeDurationMsSafe } from "@/lib/import"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { useCountdown } from "./useCountdown"
import { AudioWaveform } from "./AudioWaveform"
import { DurationBar } from "./DurationBar"
import { TakesStrip, nextTakeLabel } from "./TakesStrip"
import { useRecordingAutoAdvance, setRecordingAutoAdvance } from "@/lib/store/recording-auto-advance-pref"
import { useFileAudioAttachments } from "@/hooks/useFileAudioAttachments"
import { audioIdSeededWith, buildAudioId, uploadCellAudio, deleteCellAudio, fetchCellAudio, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { audioCachePutBlob } from "@/lib/audio/bytes-cache"
import { emitCellAudioAttach, emitCellAudioSelect } from "@/lib/sync/events-emit"
import { notifyAudioAttachmentsChanged, injectOptimisticAudioAttachment } from "@/lib/audio/audio-attachments-bus"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { markProjectHasAudioDataSoon } from "@/lib/audio/project-audio-state"
import { setTranscribeStatus } from "@/lib/audio/transcribe-status"
import { transcribeCell } from "@/lib/audio/transcribe"
import { probeMicPermission } from "./probeMicPermission"

interface Props {
  open: boolean
  project: ProjectRecord
  cells: CellData[]
  activeCellId: string | null
  username: string
  onActiveCellChange: (cellId: string) => void
  onClose: () => void
}

type Phase = "idle" | "counting" | "recording" | "preview" | "uploading" | "saved" | "error"

/** Decision 2026-08-05: recording is blocked UP FRONT while offline (a take
 *  can't be saved without a connection), instead of failing mid-flow with a
 *  raw fetch error. One copy of the message, used by every gate. */
const OFFLINE_MESSAGE =
  "You're offline — recordings can't be saved without a connection. Reconnect and try again."

export function AudioRecordingModal({
  open, project, cells, activeCellId, username,
  onActiveCellChange, onClose,
}: Props) {
  const recorder = useAudioRecorder()
  const countdown = useCountdown()
  const { session } = useFrontierSession()
  const online = useOnline()
  const [beepEnabled, setBeepEnabled] = useState(true)
  // SUB-50: saving jumps to the next cell — great on a pass down the file,
  // wrong when working one line over and over. Persisted per device.
  const autoAdvance = useRecordingAutoAdvance()
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // SUB-52 + the button-focus rule below need each other: Space on a focused
  // button activates THAT button, so the dialog must not OPEN with a button
  // focused (Base UI's default first-tabbable) or bare Space does nothing.
  // Focus the dialog surface instead; Tab still reaches every control.
  const dialogSurfaceRef = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const consumedBlobRef = useRef<Blob | null>(null)

  const activeIndex = useMemo(
    () => (activeCellId ? cells.findIndex((c) => c.id === activeCellId) : -1),
    [cells, activeCellId],
  )
  const activeCell = activeIndex >= 0 ? cells[activeIndex] : null
  // Timeline-segment-model (Scope A) — recorder decoupling. The record target
  // is ALWAYS the active cell's own timing. In a time-ordered file the media
  // layer's rows ARE media segments with their own start/end, so recording
  // there targets the media segment's window — never a subtitle's. (The old
  // coupling, where audio rode the subtitle cell and inherited its reading-
  // speed window, no longer exists: media is a separate segment.)
  const targetSec = activeCell && activeCell.startTime != null && activeCell.endTime != null
    ? Math.max(0, activeCell.endTime - activeCell.startTime)
    : null

  // Recording-slot takes for the active cell — drives the takes strip. The bus
  // refetch (poked on save below) keeps this fresh as new takes land.
  const { byCellId } = useFileAudioAttachments(open ? project.id : null, open ? (activeCell?.fileId ?? null) : null)
  const audioEntry = activeCell ? byCellId.get(activeCell.id) : undefined
  const recordingTakes = useMemo(
    () => Object.values(audioEntry?.attachments ?? {})
      // Round 8c (Sam): generated TTS is a TAKE too — one list, recorded and
      // synthesized side by side, any of them circleable.
      .filter((a) => a.slot === "recording" || a.slot === "generatedVoice")
      // The imported SOURCE clip rides the recording slot too (fileId-seeded,
      // per SUB-29 provenance) but is not a take — keep it out of the strip so
      // it can't be listed, named "Take 1", or deleted from here. The Source
      // audio track owns it.
      .filter((a) => !audioIdSeededWith(a.audioId, activeCell?.fileId ?? ""))
      .sort((a, b) => a.audioId.localeCompare(b.audioId)),
    [audioEntry, activeCell?.fileId],
  )
  // The source clip itself — the recording slot's "no take" state. Activating
  // a TTS take hands the slot back to it so the generated audio can sound.
  const sourceClip = useMemo(
    () => Object.values(audioEntry?.attachments ?? {})
      .find((a) => a.slot === "recording" && audioIdSeededWith(a.audioId, activeCell?.fileId ?? "")) ?? null,
    [audioEntry, activeCell?.fileId],
  )

  // Round 8c: takes recorded before the webm-duration fix attached without a
  // durationMs (Chrome writes no duration header into MediaRecorder blobs), so
  // their chips still fall back to section width. Heal the SELECTED take once
  // per modal visit: fetch its bytes, decode the real length, re-attach with
  // it (re-attach re-selects, which is a no-op here — and COALESCE keeps the
  // name, while passing the trims keeps them).
  const healTriedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!open || !session?.jwt || !activeCell) return
    const sel = audioEntry?.selectedAudioId
    if (!sel || healTriedRef.current.has(sel)) return
    const take = recordingTakes.find((t) => t.audioId === sel && t.slot === "recording")
    if (!take || take.durationMs != null) return
    healTriedRef.current.add(sel)
    const cell = activeCell
    void (async () => {
      try {
        const frontier = parseFrontierAudioUrl(take.url)
        if (!frontier) return
        const bytes = await fetchCellAudio({
          projectId: project.id, fileId: cell.fileId,
          audioId: frontier.audioId, ext: frontier.ext,
          getSyncToken: audioSyncTokenFetcherForSession(session),
        })
        const durationMs = await probeDurationMsSafe(
          new Blob([bytes as BlobPart], { type: take.mimeType ?? "audio/webm" }),
        )
        if (durationMs == null) return
        const healEventId = await emitCellAudioAttach({
          projectId: project.id, fileId: cell.fileId, cellId: cell.id,
          audioId: take.audioId, url: take.url, slot: "recording",
          mimeType: take.mimeType ?? undefined,
          durationMs: Math.round(durationMs),
          label: take.label ?? undefined,
          trimStartMs: take.trimStartMs ?? undefined,
          trimEndMs: take.trimEndMs ?? undefined,
          author: username,
        })
        injectOptimisticAudioAttachment(
          cell.fileId,
          cell.id,
          { ...take, durationMs: Math.round(durationMs) },
          healEventId,
        )
        notifyAudioAttachmentsChanged(cell.fileId)
      } catch {
        /* best-effort — the take simply keeps its fallback-width chip */
      }
    })()
  }, [open, session, activeCell, audioEntry?.selectedAudioId, recordingTakes, project.id, username])

  // Whenever the user switches cells, reset the capture state so the new cell
  // opens fresh.
  useEffect(() => {
    recorder.reset()
    countdown.cancel()
    setPhase("idle")
    setErrorMessage(null)
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
    consumedBlobRef.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCellId])

  // Close cleanup.
  useEffect(() => {
    if (open) return
    recorder.reset()
    countdown.cancel()
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
    consumedBlobRef.current = null
    setPhase("idle")
    setErrorMessage(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Surface recorder state transitions.
  useEffect(() => {
    if (recorder.state.kind === "recording" && phase !== "recording") {
      setPhase("recording")
    }
    if (recorder.state.kind === "stopped") {
      const blob = recorder.state.blob
      if (consumedBlobRef.current === blob) return
      consumedBlobRef.current = blob
      const url = URL.createObjectURL(blob)
      setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url })
      setPhase("preview")
    }
    if (recorder.state.kind === "error") {
      setErrorMessage(recorder.state.message)
      setPhase("error")
    }
  }, [recorder.state, phase])

  const startFlow = useCallback(() => {
    // Offline gates FIRST — when both fail it is the truer cause ("sign in"
    // is unactionable without a connection anyway).
    if (!online) {
      setErrorMessage(OFFLINE_MESSAGE)
      setPhase("error")
      return
    }
    if (!session?.jwt) {
      setErrorMessage("Sign in to save recordings")
      setPhase("error")
      return
    }
    // Probe mic permission BEFORE starting the countdown so we never count
    // down into a failed recording. If permission is denied, surface a clear
    // message instead of starting the 3-2-1 sequence. (AQU-155)
    setErrorMessage(null)
    void probeMicPermission().then((permState) => {
      if (permState === "denied") {
        // Abort — permission is blocked. Show actionable guidance.
        setPhase("error")
        setErrorMessage(
          "Microphone access is blocked. To record audio, allow microphone access in your browser's site settings and reload the page.",
        )
        return
      }
      // "granted" or "prompt" (system will ask, or already asked successfully).
      // Safe to run the countdown and hand off to the recorder.
      setPhase("counting")
      // Pre-warm the mic NOW so macOS/Chrome AGC has the 3-second countdown
      // to stabilise gain before we actually start capturing bytes.
      void recorder.prewarm()
      countdown.start({
        beep: beepEnabled,
        from: 3,
        onDone: () => {
          void recorder.start()
        },
      })
    })
  }, [beepEnabled, countdown, recorder, session?.jwt, online])

  const stopRecording = useCallback(() => {
    recorder.stop()
  }, [recorder])

  const retake = useCallback(() => {
    recorder.reset()
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
    consumedBlobRef.current = null
    setPhase("idle")
    // Immediately start the next take — user already signalled intent.
    setTimeout(startFlow, 0)
  }, [recorder, previewUrl, startFlow])

  // Round 8: durable TTS from the recording surface — the clear "regenerate"
  // counterpart to re-recording. Uses the project engine + this cell's
  // assigned voice; the result attaches to the generated-voice slot.
  const [ttsBusy, setTtsBusy] = useState(false)
  const [ttsDone, setTtsDone] = useState(false)
  useEffect(() => {
    setTtsDone(false)
  }, [activeCellId])
  const generateTts = useCallback(async () => {
    if (!online) return // the disabled button + tooltip carry the message
    if (!activeCell || !session || ttsBusy) return
    setTtsBusy(true)
    setTtsDone(false)
    try {
      // Round 8c: the TTS take is born with its permanent name like any take.
      const ok = await generateCellVoice({
        project, cell: activeCell, session, username,
        label: nextTakeLabel(recordingTakes),
      })
      if (ok) {
        setTtsDone(true)
        // You asked for this voice — make it the one that sounds. A recorded
        // take holding the recording slot would shadow it, so hand the slot
        // back to the source clip (the "no take" state).
        const recSel = audioEntry?.selectedAudioId
        if (recSel && audioIdSeededWith(recSel, activeCell.id) && sourceClip) {
          const displaceP = emitCellAudioSelect({
            projectId: project.id, fileId: activeCell.fileId, cellId: activeCell.id,
            audioId: sourceClip.audioId, slot: "recording", author: username,
          })
          injectOptimisticAudioAttachment(activeCell.fileId, activeCell.id, sourceClip, displaceP)
          await displaceP
          notifyAudioAttachmentsChanged(activeCell.fileId)
        }
      }
    } finally {
      setTtsBusy(false)
    }
  }, [online, activeCell, session, ttsBusy, project, username, recordingTakes, audioEntry?.selectedAudioId, sourceClip])

  const save = useCallback(async () => {
    if (recorder.state.kind !== "stopped") return
    // Silent backstop for the Space/Enter path — deliberately NOT the error
    // phase (that replaces the preview UI and its footer has no Save button,
    // stranding a reconnected user). The disabled Save button + the visible
    // preview notice carry the message; the take stays previewable and saves
    // once the connection returns.
    if (!online) return
    if (!session?.jwt || !activeCell) return
    setPhase("uploading")
    setErrorMessage(null)
    try {
      const blob = recorder.state.blob
      const ext = recorder.state.ext
      // SUB-48: the recorder already TIMED this take — use that, never a probe.
      // Chrome writes no duration header into MediaRecorder webm, so probing
      // the blob raced a timeout and long takes silently attached with no
      // length at all, leaving their chips stuck at section width.
      const takeDurationMs = Math.round(recorder.state.durationSec * 1000)
      const audioId = buildAudioId(activeCell.id)
      // Warm the OPFS byte cache BEFORE upload (FRO-355), keyed exactly as
      // transcribeCell/useCellAudio look bytes up (audioId+ext of the
      // frontier-audio:// URL). Once the attach lands, the take transcribes
      // and plays from local bytes — no network, no JWT — and the post-save
      // auto-transcribe below gets a deterministic cache hit. (If the upload
      // throws, save() aborts before the attach, so the orphaned cache entry
      // is unreachable and simply ages out of the LRU.)
      await audioCachePutBlob(audioId, ext, blob)
      const result = await uploadCellAudio({
        projectId: project.id,
        fileId: activeCell.fileId,
        audioId,
        ext,
        blob,
        getSyncToken: audioSyncTokenFetcherForSession(session),
      })
      // Attach the upload to the cell via the AD-2 audio grammar
      // (cell.audio.attach → cell_audio projection). The event.applied broadcast
      // pokes the per-file audio read so the clip surfaces; poke locally too so
      // it shows even if the WS is momentarily down.
      const savedAudioId = result.audioId
      setTranscribeStatus(savedAudioId, { kind: "idle" })
      markProjectHasAudioDataSoon(project.id)
      // Round 8: takes are BORN with their permanent name — never renumbered.
      const takeLabel = nextTakeLabel(recordingTakes)
      let attachEventId: string
      try {
        attachEventId = await emitCellAudioAttach({
          projectId: project.id,
          fileId: activeCell.fileId,
          cellId: activeCell.id,
          audioId: `${result.audioId}.${result.ext}`,
          url: result.url,
          slot: "recording",
          mimeType: blob.type || undefined,
          durationMs: takeDurationMs,
          label: takeLabel,
          author: username,
        })
      } catch (emitErr) {
        // F8: R2 upload succeeded but event emit failed — delete the orphaned
        // R2 object so it doesn't waste storage. Error is non-fatal for the
        // cleanup itself; we always re-throw the original emit error.
        void deleteCellAudio({
          projectId: project.id,
          fileId: activeCell.fileId,
          audioId: result.audioId,
          ext: result.ext,
          getSyncToken: audioSyncTokenFetcherForSession(session),
        })
        throw emitErr
      }
      // Optimistically surface the clip so the gutter mic flips to a play
      // button immediately. The bus poke below refetches the server projection,
      // but that races the outbox flush + projection and would otherwise leave
      // the icon stale until a manual reload.
      injectOptimisticAudioAttachment(activeCell.fileId, activeCell.id, {
        audioId: `${result.audioId}.${result.ext}`,
        url: result.url,
        slot: "recording",
        mimeType: blob.type || null,
        voiceId: null,
        referenceAudioId: null,
        durationMs: takeDurationMs,
        label: takeLabel,
        trimStartMs: null,
        trimEndMs: null,
      }, attachEventId)
      notifyAudioAttachmentsChanged(activeCell.fileId)
      setPhase("saved")
      // Fire Whisper transcription in the background — user gets karaoke as
      // soon as the model is ready; doesn't block the auto-advance.
      const fullAudioId = `${result.audioId}.${result.ext}`
      void transcribeCell({
        cell: {
          ...activeCell,
          selectedAudioId: fullAudioId,
          attachments: {
            ...activeCell.attachments,
            // SUB-49: hand transcription the REAL attachment. It re-attaches
            // when it finishes and forwards whatever it finds here; a stub of
            // `{url, type}` meant the re-attach carried no duration, which
            // wiped the take's length a minute after saving. Mirrors the seed
            // built by auto-transcribe.ts. (The mime type isn't carried on
            // this shape; the projection's COALESCE protects it instead.)
            [fullAudioId]: { url: result.url, type: "audio", durationMs: takeDurationMs },
          },
        },
        session,
        projectId: project.id,
        language: project.targetLanguage,
      })
      // Auto-advance: settle on the new cell after a brief success indication.
      // SUB-50: opt-out for repeat takes on one line, and the handle is now
      // tracked so closing/navigating inside the window can't fire a stray
      // jump after the fact.
      if (autoAdvance) {
        if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
        advanceTimerRef.current = setTimeout(() => {
          advanceTimerRef.current = null
          const nextIdx = activeIndex + 1
          if (nextIdx < cells.length) {
            onActiveCellChange(cells[nextIdx].id)
          } else {
            onClose()
          }
        }, 450)
      }
    } catch (e) {
      // A network failure that raced the online flag reads as the same
      // offline story, not a raw fetch error.
      setErrorMessage(!navigator.onLine ? OFFLINE_MESSAGE : e instanceof Error ? e.message : String(e))
      setPhase("error")
    }
  }, [recorder.state, online, session, activeCell, project.id, username, activeIndex, cells, onActiveCellChange, onClose, autoAdvance, recordingTakes])

  // A pending advance must never outlive the modal (or a manual jump): the
  // 450ms window was previously untracked, so closing inside it still fired.
  useEffect(
    () => () => {
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
      advanceTimerRef.current = null
    },
    [],
  )

  const canNav = phase === "idle" || phase === "preview" || phase === "error" || phase === "saved"
  const gotoIndex = useCallback((idx: number) => {
    if (!canNav) return
    if (idx < 0 || idx >= cells.length) return
    onActiveCellChange(cells[idx].id)
  }, [canNav, cells, onActiveCellChange])

  // While the modal is open, claim the audio keyboard shortcuts so the global
  // Space handler doesn't toggle whatever clip the user was just playing.
  useEffect(() => {
    if (!open) return
    const release = pushAudioShortcutOverride()
    return release
  }, [open])

  // Keyboard shortcuts.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Typing into an input? let it through.
      const target = e.target as HTMLElement
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return

      if (e.key === "Escape") {
        e.preventDefault()
        if (phase === "recording") { stopRecording(); return }
        if (phase === "counting") { countdown.cancel(); setPhase("idle"); return }
        if (phase === "preview") { retake(); return }
        onClose()
        return
      }
      // SUB-52: modifier check matches the other Space handlers — Cmd/Ctrl/
      // Alt+Space belong to the OS or other shortcuts, not to recording.
      // FORTIFY: Space on a FOCUSED BUTTON activates that button — a keyboard
      // user who tabbed to "Retake" and pressed Space was having the bad take
      // SAVED instead of discarded.
      if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (target?.tagName === "BUTTON" || target?.getAttribute?.("role") === "button") return
        e.preventDefault()
        if (phase === "idle" || phase === "error") { startFlow(); return }
        if (phase === "recording") { stopRecording(); return }
        if (phase === "preview") { void save(); return }
      }
      if (e.key === "ArrowRight") { e.preventDefault(); gotoIndex(activeIndex + 1); return }
      if (e.key === "ArrowLeft") { e.preventDefault(); gotoIndex(activeIndex - 1); return }
      if (e.key === "Enter" && phase === "preview") { e.preventDefault(); void save(); return }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, phase, startFlow, stopRecording, countdown, retake, save, onClose, gotoIndex, activeIndex])

  if (!open || !activeCell) return null

  const displayPhase: Phase = phase
  const elapsedMs = recorder.elapsedMs
  const targetOverrun = targetSec != null && elapsedMs / 1000 > targetSec
  const isNearLimit = recorder.isNearLimit

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      {/* AQU-230: max-h constrains the dialog to the viewport (with 4vh margin)
          so it never clips at 100% zoom on 1280×800 or smaller viewports.
          The dialog is split into a fixed header, a scrollable stage+takes
          middle, and a fixed footer so navigation buttons stay reachable. */}
      {/* finalFocus={false}: closing must NOT return focus to the opener —
          the lane's mic buttons are hover-revealed, so focus would sit on an
          INVISIBLE button where Space re-opens the recorder instead of
          driving the transport. Released focus falls to the page, where
          Space belongs to playback again. */}
      <DialogContent
        ref={dialogSurfaceRef}
        initialFocus={dialogSurfaceRef}
        finalFocus={false}
        className="flex max-w-3xl flex-col gap-0 p-0"
        style={{ maxHeight: "min(92vh, 800px)" }}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          Record audio — {activeCell.cellLabel ?? `Cell ${activeIndex + 1}`}
        </DialogTitle>
        {/* Header: cell context — fixed, never scrolls */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b px-6 pt-5 pb-4">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">
                {activeCell.cellLabel ?? `Cell ${activeIndex + 1}`}
              </span>
              {targetSec != null && (
                <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums">
                  {targetSec.toFixed(1)}s window
                </span>
              )}
              <span className="ml-auto tabular-nums">
                {activeIndex + 1} / {cells.length}
              </span>
            </div>
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground/60">Source</div>
              <div className="text-xs leading-snug text-muted-foreground">
                {activeCell.original || <span className="italic text-muted-foreground/60">empty</span>}
              </div>
            </div>
            <div className="space-y-1 pt-2">
              <div className="text-xs text-muted-foreground/60">Read aloud</div>
              <div className="text-2xl font-medium leading-relaxed">
                {activeCell.translated || <span className="italic text-base text-muted-foreground/60">not translated</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <AppTooltip
              content={
                autoAdvance
                  ? "Moving to the next line after each save — click to stay here"
                  : "Staying on this line after each save — click to move on automatically"
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="rec-auto-advance"
                aria-pressed={autoAdvance}
                onClick={() => setRecordingAutoAdvance(!autoAdvance)}
                aria-label={autoAdvance ? "Stay on this line after saving" : "Move to the next line after saving"}
                className="text-muted-foreground/60"
              >
                {autoAdvance ? <ChevronsRight className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              </Button>
            </AppTooltip>
            <AppTooltip content={beepEnabled ? "Mute countdown beep" : "Enable countdown beep"}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setBeepEnabled((v) => !v)}
                aria-label={beepEnabled ? "Mute countdown beep" : "Enable countdown beep"}
                className="text-muted-foreground/60"
              >
                {beepEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </Button>
            </AppTooltip>
            <AppTooltip content="Close (Esc)">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label="Close"
                className="text-muted-foreground/60"
              >
                <X />
              </Button>
            </AppTooltip>
          </div>
        </div>

        {/* Scrollable middle — stage + takes. Overflows internally so header
            and footer stay anchored at 100% zoom on compact viewports. */}
        <div className="min-h-0 flex-1 overflow-y-auto">

        {/* Stage — changes with phase */}
        <div className="relative flex min-h-[200px] flex-col items-center justify-center gap-4 p-6">
          {displayPhase === "counting" && countdown.count !== null && (
            <div className="flex flex-col items-center gap-3">
              <div
                key={countdown.count}
                className="text-7xl font-semibold tabular-nums text-foreground/80"
                style={{ animation: "pop 700ms ease-out" }}
              >
                {countdown.count === 0 ? "GO" : countdown.count}
              </div>
              <p className="text-xs text-muted-foreground">Recording starts in…</p>
            </div>
          )}

          {displayPhase === "recording" && (
            <div className="w-full space-y-4">
              <div className="flex items-center justify-center gap-2">
                <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
                <span className="text-sm font-medium">Recording</span>
              </div>
              <AudioWaveform stream={recorder.stream} height={56} className="rounded-md border bg-muted/40" />
              {targetSec != null
                ? <DurationBar elapsedMs={elapsedMs} targetSec={targetSec} />
                : <div className="text-center text-2xl font-semibold tabular-nums">{formatClock(elapsedMs)}</div>}
              {targetOverrun && (
                <p className="text-center text-xs font-medium text-red-500">
                  Past target duration — this will overrun the cue.
                </p>
              )}
              {isNearLimit && (
                <p className="text-center text-xs font-medium text-amber-500">
                  Recording is 25 minutes — it will stop automatically at 30 minutes.
                </p>
              )}
            </div>
          )}

          {displayPhase === "preview" && previewUrl && (
            <div className="w-full space-y-4">
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Check className="h-4 w-4 text-emerald-500" /> Captured — review and save, or retake.
              </div>
              <audio
                ref={previewAudioRef}
                src={previewUrl}
                controls
                className="w-full"
                preload="auto"
              />
              {targetSec != null && (
                <DurationBar elapsedMs={elapsedMs} targetSec={targetSec} />
              )}
              {/* Connectivity died mid-flow: the take is safe (capture is
                  local) — say why Save is disabled. Derived, so it clears
                  itself the moment the connection returns. */}
              {!online && (
                <p data-testid="rec-offline-notice" className="text-center text-xs font-medium text-amber-500">
                  {OFFLINE_MESSAGE}
                </p>
              )}
            </div>
          )}

          {displayPhase === "uploading" && (
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <Spinner className="size-7" />
              <p className="text-sm">Uploading…</p>
            </div>
          )}

          {displayPhase === "saved" && (
            <div className="flex flex-col items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-emerald-500/10">
                <Check className="h-6 w-6 text-emerald-500" />
              </div>
              <p className="text-sm text-muted-foreground">Saved — moving to next cell…</p>
            </div>
          )}

          {displayPhase === "idle" && (
            <div className="flex flex-col items-center gap-3 text-center">
              <Mic className="h-10 w-10 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">
                Press <kbd className="rounded border bg-muted px-1 py-0.5 text-[11px] font-medium">Space</kbd> or click Start.
                The beep plays a 3-2-1 countdown before recording.
              </p>
            </div>
          )}

          {displayPhase === "error" && (
            <div className="space-y-2 text-center">
              <p className="text-sm font-medium text-destructive">{errorMessage ?? "Something went wrong."}</p>
              <p className="text-xs text-muted-foreground">Press Space or Start to try again.</p>
            </div>
          )}
        </div>

        {/* Takes — audition / circle / delete prior recordings for this cell. */}
        {(phase === "idle" || phase === "preview" || phase === "saved" || phase === "error") && activeCell && (
          <TakesStrip
            projectId={project.id}
            fileId={activeCell.fileId}
            cellId={activeCell.id}
            takes={recordingTakes}
            selectedAudioId={audioEntry?.selectedAudioId ?? null}
            selectedGeneratedAudioId={audioEntry?.selectedGeneratedVoiceAudioId ?? null}
            sourceClip={sourceClip}
            author={username}
            session={session ?? null}
          />
        )}

        </div>{/* end scrollable middle */}

        {/* Footer: nav + primary action — fixed, never scrolls */}
        <div className="flex shrink-0 items-center gap-2 border-t bg-muted/30 px-5 py-3">
          <AppTooltip content="Previous cell (←)">
            <Button
              variant="ghost"
              size="sm"
              disabled={!canNav || activeIndex <= 0}
              onClick={() => gotoIndex(activeIndex - 1)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" /> Prev
            </Button>
          </AppTooltip>
          <AppTooltip content="Next cell (→)">
            <Button
              variant="ghost"
              size="sm"
              disabled={!canNav || activeIndex >= cells.length - 1}
              onClick={() => gotoIndex(activeIndex + 1)}
            >
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </AppTooltip>

          <div className="flex-1" />

          {displayPhase === "preview" && (
            <>
              <AppTooltip content="Retake (Esc)">
                <Button variant="outline" size="sm" onClick={retake}>
                  <RefreshCw className="mr-1 h-4 w-4" /> Retake
                </Button>
              </AppTooltip>
              <AppTooltip content={online ? "Save (Space or Enter)" : OFFLINE_MESSAGE}>
                <span className="inline-flex">
                  <Button size="sm" data-testid="rec-save" disabled={!online} onClick={save}>
                    <Check className="mr-1 h-4 w-4" /> Save
                  </Button>
                </span>
              </AppTooltip>
            </>
          )}

          {displayPhase === "recording" && (
            <AppTooltip content="Stop (Space or Esc)">
              <Button variant="destructive" size="sm" onClick={stopRecording}>
                <Square className="mr-1 h-4 w-4" /> Stop
              </Button>
            </AppTooltip>
          )}

          {(displayPhase === "idle" || displayPhase === "error") && (
            <>
              {/* Round 8: a clear re-record vs REGENERATE choice — durable TTS
                  right where recording lives. Round 8c: the result is a TAKE —
                  it joins the list below (sparkle row) and becomes the one
                  that sounds. */}
              <AppTooltip
                content={
                  !online
                    ? OFFLINE_MESSAGE
                    : !activeCell?.translated?.trim()
                      ? "Translate this line first to generate voice"
                      : ttsDone
                        ? "Voice generated — it plays on the Target track"
                        : "Generate this line's voice with the project's engine"
                }
              >
                <span className="inline-flex">
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="rec-generate-tts"
                    disabled={!online || !activeCell?.translated?.trim() || ttsBusy}
                    onClick={() => void generateTts()}
                  >
                    {ttsBusy ? (
                      <Spinner className="mr-1 size-4" />
                    ) : ttsDone ? (
                      <Check className="mr-1 h-4 w-4 text-emerald-500" />
                    ) : (
                      <Sparkles className="mr-1 h-4 w-4" />
                    )}
                    Generate TTS
                  </Button>
                </span>
              </AppTooltip>
              <AppTooltip content={online ? "Start recording (Space)" : OFFLINE_MESSAGE}>
                <span className="inline-flex">
                  <Button size="sm" data-testid="rec-start" disabled={!online} onClick={startFlow}>
                    <Play className="mr-1 h-4 w-4" /> Start
                  </Button>
                </span>
              </AppTooltip>
            </>
          )}

          {displayPhase === "counting" && (
            <Button variant="outline" size="sm" onClick={() => { countdown.cancel(); setPhase("idle") }}>
              Cancel countdown
            </Button>
          )}
        </div>

        <style>{`
          @keyframes pop {
            0% { transform: scale(0.6); opacity: 0; }
            30% { transform: scale(1.15); opacity: 1; }
            100% { transform: scale(1); opacity: 1; }
          }
        `}</style>
      </DialogContent>
    </Dialog>
  )
}

function formatClock(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms))
  const s = Math.floor(totalMs / 1000)
  const m = Math.floor(s / 60)
  const ss = String(s % 60).padStart(2, "0")
  const tenths = Math.floor((totalMs % 1000) / 100)
  return `${m}:${ss}.${tenths}`
}
