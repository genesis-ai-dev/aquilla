// Full-screen recording dialog. States: idle → counting → recording →
// preview → uploading → saved. Next/Prev cell navigation lives in the footer
// and in arrow-key shortcuts. Space toggles start/stop; Esc smartly
// cancels/closes based on current phase.
//
// This deliberately owns its own recorder + upload — the per-cell inline
// "capture-and-save" hook is not reused here because the modal adds a
// preview/retake step between stop and upload.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Y from "yjs"
import { ChevronLeft, ChevronRight, Mic, Play, Square, X, Loader2, Volume2, VolumeX, RefreshCw, Check } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useAudioRecorder } from "@/hooks/useAudioRecorder"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { pushAudioShortcutOverride } from "@/lib/audio/audio-coordinator"
import { useCountdown } from "./useCountdown"
import { AudioWaveform } from "./AudioWaveform"
import { DurationBar } from "./DurationBar"
import { buildAudioId, uploadCellAudio } from "@/lib/audio/upload"
import { attachAudioToCell } from "@/lib/audio/attach"
import { markProjectHasAudioDataSoon } from "@/lib/audio/project-audio-state"
import { transcribeAndStoreTimings } from "@/lib/audio/transcribe"
import { whisperLanguageFromTag } from "@/lib/audio/language"
import { setTranscribeStatus } from "@/lib/audio/transcribe-status"
import { AiModelConsentDeniedError } from "@/lib/audio/ai-consent"

interface Props {
  open: boolean
  project: ProjectRecord
  doc: Y.Doc
  cells: CellData[]
  activeCellId: string | null
  username: string
  onActiveCellChange: (cellId: string) => void
  onClose: () => void
}

type Phase = "idle" | "counting" | "recording" | "preview" | "uploading" | "saved" | "error"

export function AudioRecordingModal({
  open, project, doc, cells, activeCellId, username,
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
  const targetSec = activeCell && activeCell.startTime != null && activeCell.endTime != null
    ? Math.max(0, activeCell.endTime - activeCell.startTime)
    : null

  const isGitProject = project.origin?.kind === "git"

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
    if (!isGitProject ? false : true) {
      /* placeholder — block only runs to satisfy the type-narrowing below */
    }
    if (isGitProject) {
      setErrorMessage("Recording on GitLab projects isn't available yet")
      setPhase("error")
      return
    }
    if (!session?.jwt) {
      setErrorMessage("Sign in to save recordings")
      setPhase("error")
      return
    }
    setErrorMessage(null)
    setPhase("counting")
    countdown.start({
      beep: beepEnabled,
      from: 3,
      onDone: () => {
        void recorder.start()
      },
    })
  }, [beepEnabled, countdown, isGitProject, recorder, session?.jwt])

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

  const save = useCallback(async () => {
    if (recorder.state.kind !== "stopped") return
    if (!session?.jwt || !activeCell) return
    setPhase("uploading")
    setErrorMessage(null)
    try {
      const blob = recorder.state.blob
      const ext = recorder.state.ext
      const audioId = buildAudioId(activeCell.id)
      const result = await uploadCellAudio({
        session,
        projectId: project.id,
        audioId,
        ext,
        blob,
      })
      attachAudioToCell(doc, activeCell.id, {
        audioId: result.audioId,
        url: result.url,
        username,
        mimeType: recorder.state.mimeType,
      })
      markProjectHasAudioDataSoon(project.id)
      // Fire-and-forget transcription. The modal returns to idle/saved
      // immediately; the per-cell badge in EditorTable surfaces progress.
      const cellId = activeCell.id
      const savedAudioId = result.audioId
      const cellTextSnapshot = activeCell.translated
      const audioBytes = new Uint8Array(await blob.arrayBuffer())
      void (async () => {
        setTranscribeStatus(savedAudioId, { kind: "loading", loaded: 0, total: 0, file: "" })
        const startedAt = Date.now()
        try {
          const out = await transcribeAndStoreTimings(doc, cellId, savedAudioId, audioBytes, {
            cellText: cellTextSnapshot,
            language: whisperLanguageFromTag(project.targetLanguage),
            onProgress: (p) => {
              setTranscribeStatus(savedAudioId, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
              if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
                setTranscribeStatus(savedAudioId, { kind: "transcribing" })
              }
            },
          })
          setTranscribeStatus(savedAudioId, {
            kind: "done",
            wordCount: out.timings.length,
            durationMs: Date.now() - startedAt,
          })
        } catch (e) {
          if (e instanceof AiModelConsentDeniedError) {
            setTranscribeStatus(savedAudioId, { kind: "idle" })
          } else {
            setTranscribeStatus(savedAudioId, {
              kind: "error",
              message: e instanceof Error ? e.message : String(e),
            })
          }
        }
      })()
      setPhase("saved")
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
  }, [recorder.state, session, activeCell, project.id, doc, username, activeIndex, cells, onActiveCellChange, onClose])

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

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-w-2xl gap-0 p-0" showCloseButton={false}>
        <DialogTitle className="sr-only">
          Record audio — {activeCell.cellLabel ?? `Cell ${activeIndex + 1}`}
        </DialogTitle>
        {/* Header: cell context */}
        <div className="flex items-start justify-between gap-4 border-b px-6 pt-5 pb-4">
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
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Source</div>
              <div className="text-sm leading-snug">{activeCell.original || <span className="italic text-muted-foreground/60">empty</span>}</div>
            </div>
            <div className="space-y-0.5 pt-1">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Target</div>
              <div className="text-sm leading-snug">
                {activeCell.translated || <span className="italic text-muted-foreground/60">not translated</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setBeepEnabled((v) => !v)}
              title={beepEnabled ? "Mute countdown beep" : "Enable countdown beep"}
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            >
              {beepEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close (Esc)"
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Stage — changes with phase */}
        <div className="relative flex min-h-[240px] flex-col items-center justify-center gap-4 p-6">
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
              <Loader2 className="h-7 w-7 animate-spin" />
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

        {/* Footer: nav + primary action */}
        <div className="flex items-center gap-2 border-t bg-muted/30 px-5 py-3">
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
            <Button size="sm" onClick={startFlow} disabled={isGitProject}>
              <Play className="mr-1 h-4 w-4" /> Start
            </Button>
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
