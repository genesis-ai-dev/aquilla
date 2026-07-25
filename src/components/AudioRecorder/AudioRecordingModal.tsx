// Full-screen recording dialog. States: idle → counting → recording →
// preview → uploading → saved. Next/Prev cell navigation lives in the footer
// and in arrow-key shortcuts. Space toggles start/stop; Esc smartly
// cancels/closes based on current phase.
//
// This deliberately owns its own recorder + upload — the per-cell inline
// "capture-and-save" hook is not reused here because the modal adds a
// preview/retake step between stop and upload.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Mic, Play, Sparkles, Square, X, Volume2, VolumeX, RefreshCw, Check } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useAudioRecorder } from "@/hooks/useAudioRecorder"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { pushAudioShortcutOverride } from "@/lib/audio/audio-coordinator"
import { probeDurationMsSafe } from "@/lib/import"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { useCountdown } from "./useCountdown"
import { AudioWaveform } from "./AudioWaveform"
import { DurationBar } from "./DurationBar"
import { TakesStrip } from "./TakesStrip"
import { useFileAudioAttachments } from "@/hooks/useFileAudioAttachments"
import { buildAudioId, uploadCellAudio, deleteCellAudio } from "@/lib/audio/upload"
import { audioCachePutBlob } from "@/lib/audio/bytes-cache"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
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

export function AudioRecordingModal({
  open, project, cells, activeCellId, username,
  onActiveCellChange, onClose,
}: Props) {
  const recorder = useAudioRecorder()
  const countdown = useCountdown()
  const { session } = useFrontierSession()
  const [beepEnabled, setBeepEnabled] = useState(true)
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
      .filter((a) => a.slot === "recording")
      .sort((a, b) => a.audioId.localeCompare(b.audioId)),
    [audioEntry],
  )

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
  }, [beepEnabled, countdown, recorder, session?.jwt])

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
    if (!activeCell || !session || ttsBusy) return
    setTtsBusy(true)
    setTtsDone(false)
    try {
      const ok = await generateCellVoice({ project, cell: activeCell, session, username })
      if (ok) setTtsDone(true)
    } finally {
      setTtsBusy(false)
    }
  }, [activeCell, session, ttsBusy, project, username])

  const save = useCallback(async () => {
    if (recorder.state.kind !== "stopped") return
    if (!session?.jwt || !activeCell) return
    setPhase("uploading")
    setErrorMessage(null)
    try {
      const blob = recorder.state.blob
      const ext = recorder.state.ext
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
      // Round 6: record the take's duration so its Target-track chip renders
      // at the recording's real length. Best-effort — undefined = today's null.
      const takeDurationMs = await probeDurationMsSafe(blob)
      try {
        await emitCellAudioAttach({
          projectId: project.id,
          fileId: activeCell.fileId,
          cellId: activeCell.id,
          audioId: `${result.audioId}.${result.ext}`,
          url: result.url,
          slot: "recording",
          mimeType: blob.type || undefined,
          durationMs: takeDurationMs,
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
        durationMs: takeDurationMs ?? null,
        trimStartMs: null,
        trimEndMs: null,
      })
      notifyAudioAttachmentsChanged(activeCell.fileId)
      setPhase("saved")
      // Fire Whisper transcription in the background — user gets karaoke as
      // soon as the model is ready; doesn't block the auto-advance.
      const fullAudioId = `${result.audioId}.${result.ext}`
      void transcribeCell({
        cell: {
          ...activeCell,
          selectedAudioId: fullAudioId,
          attachments: { ...activeCell.attachments, [fullAudioId]: { url: result.url, type: "audio" } },
        },
        session,
        projectId: project.id,
        language: project.targetLanguage,
      })
      // Auto-advance: settle on the new cell after a brief success indication.
      setTimeout(() => {
        const nextIdx = activeIndex + 1
        if (nextIdx < cells.length) {
          onActiveCellChange(cells[nextIdx].id)
        } else {
          onClose()
        }
      }, 450)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e))
      setPhase("error")
    }
  }, [recorder.state, session, activeCell, project.id, username, activeIndex, cells, onActiveCellChange, onClose])

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
      if (e.key === " ") {
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
      <DialogContent
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
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Source</div>
              <div className="text-xs leading-snug text-muted-foreground">
                {activeCell.original || <span className="italic text-muted-foreground/60">empty</span>}
              </div>
            </div>
            <div className="space-y-1 pt-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Read aloud</div>
              <div className="text-2xl font-medium leading-relaxed">
                {activeCell.translated || <span className="italic text-base text-muted-foreground/60">not translated</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
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
                <X className="h-4 w-4" />
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
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
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
            author={username}
            session={session ?? null}
          />
        )}

        </div>{/* end scrollable middle */}

        {/* Footer: nav + primary action — fixed, never scrolls */}
        <div className="flex shrink-0 items-center gap-2 border-t bg-muted/30 px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={!canNav || activeIndex <= 0}
            onClick={() => gotoIndex(activeIndex - 1)}
            title="Previous cell (←)"
          >
            <ChevronLeft className="mr-1 h-4 w-4" /> Prev
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canNav || activeIndex >= cells.length - 1}
            onClick={() => gotoIndex(activeIndex + 1)}
            title="Next cell (→)"
          >
            Next <ChevronRight className="ml-1 h-4 w-4" />
          </Button>

          <div className="flex-1" />

          {displayPhase === "preview" && (
            <>
              <Button variant="outline" size="sm" onClick={retake} title="Retake (Esc)">
                <RefreshCw className="mr-1 h-4 w-4" /> Retake
              </Button>
              <Button size="sm" onClick={save} title="Save (Space or Enter)">
                <Check className="mr-1 h-4 w-4" /> Save
              </Button>
            </>
          )}

          {displayPhase === "recording" && (
            <Button variant="destructive" size="sm" onClick={stopRecording} title="Stop (Space or Esc)">
              <Square className="mr-1 h-4 w-4" /> Stop
            </Button>
          )}

          {(displayPhase === "idle" || displayPhase === "error") && (
            <>
              {/* Round 8: a clear re-record vs REGENERATE choice — durable TTS
                  right where recording lives. The result lands in the
                  generated-voice slot (the sparkle chip on the Target track),
                  so it deliberately doesn't join the recorded-takes list. */}
              <AppTooltip
                content={
                  !activeCell?.translated?.trim()
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
                    disabled={!activeCell?.translated?.trim() || ttsBusy}
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
              <Button size="sm" onClick={startFlow}>
                <Play className="mr-1 h-4 w-4" /> Start
              </Button>
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
