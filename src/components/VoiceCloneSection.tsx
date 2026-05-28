// Voice-clone reference editor inside the Voice Studio's voice editor. Lets the user attach a
// short reference clip (record from the mic, or upload an audio file) whose
// timbre TTS output is re-voiced into via Seed-VC. The clip is stored
// project-scoped in R2 (uploadVoiceReference); the voice keeps a pointer to it
// in `referenceAudioId`. Removing the reference reverts the voice to plain TTS.

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Mic, Pause, Play, Sparkles, Square, Trash2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Voice } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { useAudioRecorder } from "@/hooks/useAudioRecorder"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import {
  buildVoiceReferenceId,
  uploadVoiceReference,
  fetchVoiceReference,
} from "@/lib/audio/voice-clone"

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
  const recorder = useAudioRecorder()
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  const consumedBlobRef = useRef<Blob | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const sectionRef = useRef<HTMLDivElement | null>(null)
  const [pulse, setPulse] = useState(false)

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
        setStatus({ kind: "error", message: "No project context for upload." })
        return
      }
      if (blob.size > MAX_REFERENCE_BYTES) {
        setStatus({ kind: "error", message: "Reference clip too large (max 8 MB). Use a few seconds." })
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
        onChange({ referenceAudioId })
        setStatus({ kind: "idle" })
      } catch (e) {
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) })
      }
    },
    [projectId, fileId, session, onChange],
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

  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ""
      if (!file) return
      const ext = (file.name.split(".").pop() || "wav").toLowerCase()
      void upload(file, ext)
    },
    [upload],
  )

  const removeReference = useCallback(() => {
    onChange({ referenceAudioId: undefined })
    setStatus({ kind: "idle" })
  }, [onChange])

  return (
    <div
      ref={sectionRef}
      className={cn(
        "rounded-md border border-violet-200/60 bg-violet-50/40 p-3 transition-shadow dark:border-violet-500/20 dark:bg-violet-950/20",
        pulse && "ring-2 ring-violet-400/70 ring-offset-1",
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        <Sparkles className="h-3.5 w-3.5 text-violet-500" /> Voice profile (clone)
        {voice.referenceAudioId && (
          <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-600 dark:text-violet-300">
            Active
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Record or upload a short reference clip (5–15s of one clear speaker). This voice's
        generated audio is then re-voiced into that timbre via Seed-VC — so the whole project
        can speak in a single, consistent voice.
      </p>

      {!hasContext ? (
        <p className="text-xs text-muted-foreground">
          Open this from a project workspace to record or upload a reference clip.
        </p>
      ) : voice.referenceAudioId ? (
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
            size="sm"
            variant="ghost"
            onClick={removeReference}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove clone
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={status.kind === "uploading"}
          >
            <Upload className="mr-1 h-3.5 w-3.5" /> Replace
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {isRecording ? (
            <Button type="button" size="sm" variant="destructive" onClick={() => recorder.stop()}>
              <Square className="mr-1 h-3.5 w-3.5" /> Stop ({(recorder.elapsedMs / 1000).toFixed(1)}s)
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => void recorder.start()}
              disabled={status.kind === "uploading"}
            >
              <Mic className="mr-1 h-3.5 w-3.5" /> Record reference
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={status.kind === "uploading" || isRecording}
          >
            <Upload className="mr-1 h-3.5 w-3.5" /> Upload audio
          </Button>
          {status.kind === "uploading" && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading…
            </span>
          )}
        </div>
      )}

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
      const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
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
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={toggle}
      className={cn(state === "error" && "text-destructive")}
      title="Preview reference clip"
    >
      {state === "loading" ? (
        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
      ) : state === "playing" ? (
        <Pause className="mr-1 h-3.5 w-3.5" />
      ) : (
        <Play className="mr-1 h-3.5 w-3.5" />
      )}
      {state === "error" ? "Preview failed" : "Preview"}
    </Button>
  )
}
