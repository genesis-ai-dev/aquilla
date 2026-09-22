// Voice-clone reference editor: record from the mic or upload a clip whose
// timbre generated audio is re-voiced into. The clip is stored project-scoped
// in R2 (uploadVoiceReference); the voice keeps a pointer to it in
// `referenceAudioId`. Removing the reference reverts the voice to plain TTS.
// Lives on the Clone tab's "Reference audio" panel (NewVoiceModal).

import { useCallback, useEffect, useRef, useState } from "react"
import { FileAudio, Mic, Pause, Play, Square, Trash2, Upload } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { Voice } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { useAudioRecorder } from "@/hooks/useAudioRecorder"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { audioMimeForExt } from "@/lib/audio/mime"
import { isRecordedCloneClip } from "@/lib/audio/voices"
import {
  buildVoiceReferenceId,
  uploadVoiceReference,
  fetchVoiceReference,
} from "@/lib/audio/voice-clone"

const AUDIO_EXTS = new Set(["wav", "webm", "mp3", "m4a", "ogg", "oga", "opus", "flac", "aac"])

function extFromFile(file: File): string {
  const fromName = file.name.split(".").pop()?.toLowerCase()
  if (fromName && fromName !== file.name.toLowerCase() && fromName.length <= 5) return fromName
  const subtype = file.type.split("/")[1]?.split(";")[0]
  if (subtype === "mpeg") return "mp3"
  if (subtype === "x-m4a") return "m4a"
  if (subtype) return subtype
  return "wav"
}

function isAudioFile(file: File): boolean {
  if (file.type.startsWith("audio/")) return true
  return AUDIO_EXTS.has(extFromFile(file))
}

interface Props {
  voice: Voice
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  onChange: (patch: Partial<Voice>) => void
  /** Bumped by the library when a clone profile is created — scrolls this
   *  section into view and pulses it so the recorder is the obvious next step. */
  focusSignal?: number
}

type Status =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "error"; message: string }

const MAX_REFERENCE_BYTES = 8 * 1024 * 1024 // 8 MB — Seed-VC only needs a few seconds.

export function VoiceCloneSection({ voice, projectId, fileId, session, onChange, focusSignal }: Props) {
  const t = useT()
  // Hand the 8 MB budget to the recorder so it becomes an early hard stop
  // (~78s of WAV, ~4min of webm/opus) instead of a rejection delivered after
  // the person has finished speaking. The reference follows the device's WAV
  // preference like any other take: reference-extract.ts already uploads WAV
  // through uploadVoiceReference, so that server path is proven, and Seed-VC
  // reads only the first few seconds either way.
  const recorder = useAudioRecorder({ maxBytes: MAX_REFERENCE_BYTES })
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  const consumedBlobRef = useRef<Blob | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const sectionRef = useRef<HTMLDivElement | null>(null)
  const [pulse, setPulse] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const hasContext = Boolean(projectId && fileId && session?.jwt)

  // When the library asks us to (a clone profile was just created), bring the
  // recorder into view and pulse so the next step is unmistakable.
  useEffect(() => {
    if (!focusSignal) return
    sectionRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })
    setPulse(true)
    const t = setTimeout(() => setPulse(false), 1600)
    return () => clearTimeout(t)
  }, [focusSignal])
  const isRecording = recorder.state.kind === "recording" || recorder.state.kind === "requesting"

  const upload = useCallback(
    async (blob: Blob, ext: string) => {
      if (!projectId || !fileId) {
        setStatus({ kind: "error", message: t("audio.clone.errorNoContext") })
        return
      }
      // Backstop only, and unreachable for a recorded clip now that the
      // recorder stops itself at this budget. It still guards the file-picker
      // path below, and it fails loudly rather than silently if the capture
      // format's byte rate is ever wrong.
      if (blob.size > MAX_REFERENCE_BYTES) {
        setStatus({ kind: "error", message: t("audio.clone.errorTooLarge") })
        return
      }
      setStatus({ kind: "uploading" })
      try {
        const referenceAudioId = buildVoiceReferenceId(ext)
        await uploadVoiceReference({
          projectId,
          fileId,
          referenceAudioId,
          blob,
          getSyncToken: audioSyncTokenFetcherForSession(session ?? null),
        })
        onChange({ referenceAudioId, referenceTakeKey: undefined })
        setStatus({ kind: "idle" })
      } catch (e) {
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) })
      }
    },
    [projectId, fileId, session, onChange, t],
  )

  // When a recording stops, auto-upload the captured blob exactly once.
  useEffect(() => {
    if (recorder.state.kind !== "stopped") return
    const { blob, ext } = recorder.state
    if (consumedBlobRef.current === blob) return
    consumedBlobRef.current = blob
    void upload(blob, ext).finally(() => recorder.reset())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.state])

  // Stop any in-flight capture when switching voices / unmounting.
  useEffect(() => {
    return () => recorder.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.id])

  const ingestFile = useCallback(
    (file: File) => {
      if (!isAudioFile(file)) {
        setStatus({ kind: "error", message: t("audio.clone.errorNotAudio") })
        return
      }
      void upload(file, extFromFile(file))
    },
    [upload, t],
  )

  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ""
      if (!file) return
      ingestFile(file)
    },
    [ingestFile],
  )

  const dropEnabled = hasContext && !isRecording && status.kind !== "uploading"

  const removeReference = useCallback(() => {
    onChange({ referenceAudioId: undefined, referenceTakeKey: undefined })
    setStatus({ kind: "idle" })
  }, [onChange])

  const clipFilled = isRecordedCloneClip(voice)

  return (
    <div ref={sectionRef}>
      {!hasContext ? (
        <p className="text-xs text-muted-foreground">
          {t("audio.clone.needsContext")}
        </p>
      ) : clipFilled && voice.referenceAudioId ? (
        <div
          className={cn(
            "rounded-md border border-border bg-muted/30 p-3 transition-shadow dark:border-border dark:bg-muted/30",
            pulse && "ring-2 ring-primary/50 ring-offset-1",
          )}
        >
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <Badge variant="secondary">{t("audio.clone.activeBadge")}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ReferencePreview
              key={voice.referenceAudioId}
              projectId={projectId!}
              fileId={fileId!}
              referenceAudioId={voice.referenceAudioId}
              session={session ?? null}
            />
            <Button
              type="button"
              variant="ghost"
              onClick={removeReference}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="me-1 h-3.5 w-3.5" /> {t("audio.clone.removeButton")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={status.kind === "uploading"}
            >
              <Upload className="me-1 h-3.5 w-3.5" /> {t("audio.clone.replaceButton")}
            </Button>
          </div>
        </div>
      ) : (
        <div
          role="group"
          aria-label={t("audio.clone.dropzoneTitle")}
          className={cn(
            "flex flex-col items-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
            dragOver ? "border-primary bg-primary/5" : "border-muted",
            pulse && "ring-2 ring-primary/50 ring-offset-1",
          )}
          onDragOver={(e) => {
            e.preventDefault()
            if (dropEnabled) setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            if (!dropEnabled) return
            const file = e.dataTransfer.files?.[0]
            if (file) ingestFile(file)
          }}
        >
          {status.kind === "uploading" ? (
            <p className="flex items-center gap-2 text-sm font-medium">
              <Spinner className="size-4" /> {t("common.uploading")}
            </p>
          ) : (
            <>
              <FileAudio className={cn("mb-2 h-6 w-6", dragOver ? "text-primary" : "text-muted-foreground")} />
              <p className="text-sm font-medium">{t("audio.clone.dropzoneTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {dragOver ? t("audio.clone.dropzoneDrop") : t("audio.clone.dropzoneHint")}
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                {isRecording ? (
                  <Button type="button" variant="destructive" onClick={() => recorder.stop()}>
                    <Square className="me-1 h-3.5 w-3.5" /> {t("audio.clone.stopRecordingButton", { seconds: (recorder.elapsedMs / 1000).toFixed(1) })}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => void recorder.start()}
                  >
                    <Mic className="me-1 h-3.5 w-3.5" /> {t("audio.clone.recordButton")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isRecording}
                >
                  <Upload className="me-1 h-3.5 w-3.5" /> {t("audio.clone.uploadButton")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* i18n-exempt "error" is a clone-status tag, not copy */}
      {status.kind === "error" && (
        <p className="mt-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {status.message}
        </p>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={onPickFile}
      />
    </div>
  )
}

interface PreviewProps {
  projectId: string
  fileId: string
  referenceAudioId: string
  session: FrontierSession | null
}

/** Fetch the reference clip from R2 and play it back. */
export function ReferencePreview({ projectId, fileId, referenceAudioId, session }: PreviewProps) {
  const t = useT()
  const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle")
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  const cleanup = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  useEffect(() => cleanup, [cleanup])

  const toggle = useCallback(async () => {
    if (state === "playing") { cleanup(); setState("idle"); return }
    setState("loading")
    try {
      const bytes = await fetchVoiceReference({
        projectId,
        fileId,
        referenceAudioId,
        getSyncToken: audioSyncTokenFetcherForSession(session),
      })
      // AQU: stamp the container type from the ref id's extension — Safari
      // refuses to play typeless blobs (see src/lib/audio/mime.ts).
      const refExt = referenceAudioId.slice(referenceAudioId.lastIndexOf(".") + 1)
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: audioMimeForExt(refExt) }))
      urlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => { cleanup(); setState("idle") }
      audio.onerror = () => { setState("error") }
      setState("playing")
      await audio.play()
    } catch {
      setState("error")
    }
  }, [state, projectId, fileId, referenceAudioId, session, cleanup])

  return (
    <AppTooltip content={t("audio.clone.previewTooltip")}>
      <Button
        type="button"
        variant="outline"
        onClick={toggle}
        className={cn(state === "error" && "text-destructive")}
      >
      {state === "loading" ? (
        <Spinner className="me-1 size-3.5" />
      ) : state === "playing" ? (
        <Pause className="me-1 h-3.5 w-3.5" />
      ) : (
        <Play className="me-1 h-3.5 w-3.5" />
      )}
      {state === "error" ? t("audio.clone.previewFailed") : t("common.preview")}
    </Button>
    </AppTooltip>
  )
}
