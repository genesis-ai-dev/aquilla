// The clone step of the ElevenLabs flow (AQU-2299), opened from the grid's
// "Clone a voice" card: an Instant Voice Clone in the user's own ElevenLabs
// account. One drop zone takes recordings and also lists this project's
// recorded lines (by their text) to add in one tap; the recordings list shows
// each length and the total. Same consent gate as Train voice — the
// organization confirms the speaker's consent and the worker keeps that
// confirmation as an audit record. Background noise is always removed.
import { useCallback, useMemo, useState } from "react"
import { Check, FileAudio, Upload, X } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { VoiceConsentBox } from "@/components/voice/VoiceConsentBox"
import { cn } from "@/lib/utils"
import { probeDurationMsSafe } from "@/lib/import"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { fetchTakeAsFile } from "@/lib/audio/take-file"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { CUSTOM_VOICE_MAX_CLIP_BYTES } from "@/lib/audio/custom-voice"
import {
  ELEVENLABS_CLONE_MAX_CLIPS,
  ELEVENLABS_CLONE_MIN_SECONDS,
  ELEVENLABS_CLONE_RECOMMENDED_SECONDS,
} from "@/lib/audio/elevenlabs/settings"
import { cloneElevenLabsVoice, type ClonedElevenLabsVoice } from "@/lib/sync/elevenlabs"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import { lineSnippet, linesWithTakes } from "./helpers"

interface Recording {
  file: File
  seconds: number | null
  /** Set when the recording came from one of the project's lines. */
  audioId?: string
}

export interface ElevenLabsClonePanelProps {
  /** The voice's name (the modal's Name field) — also the ElevenLabs voice name. */
  name: string
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  cells: CellData[]
  /** False when the connected plan can't clone; undefined while unknown. */
  canClone?: boolean
  onCloned: (cloned: ClonedElevenLabsVoice) => void
  onBack: () => void
}

const fmt = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`

export function ElevenLabsClonePanel({
  name, projectId, fileId, session, cells, canClone, onCloned, onBack,
}: ElevenLabsClonePanelProps) {
  const t = useT()
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [consent, setConsent] = useState(false)
  const [phase, setPhase] = useState<{ kind: "idle" } | { kind: "uploading"; done: number; total: number } | { kind: "cloning" }>({ kind: "idle" })
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [fetchingTake, setFetchingTake] = useState<string | null>(null)
  const busy = phase.kind !== "idle"

  const addFiles = useCallback((files: ArrayLike<File> | null, audioId?: string) => {
    if (!files) return
    const added = Array.from(files)
    setRecordings((cur) => [...cur, ...added.map((file) => ({ file, seconds: null, audioId }))].slice(0, ELEVENLABS_CLONE_MAX_CLIPS))
    for (const file of added) {
      void probeDurationMsSafe(file).then((ms) => {
        setRecordings((cur) => cur.map((r) => (r.file === file ? { ...r, seconds: ms == null ? 0 : ms / 1000 } : r)))
      })
    }
  }, [])

  const takes = useMemo(() => linesWithTakes(cells), [cells])
  const addedTakes = new Set(recordings.flatMap((r) => (r.audioId ? [r.audioId] : [])))
  const addTake = useCallback(async (cell: CellData, audioId: string) => {
    if (!projectId) return
    setFetchingTake(audioId)
    try {
      const take = await fetchTakeAsFile({ projectId, cell, audioId, session: session ?? null })
      // Listed by the line it came from: every take is "Take 1" on its own line.
      const ext = take.name.includes(".") ? take.name.slice(take.name.lastIndexOf(".")) : ""
      addFiles([new File([take], `${lineSnippet(cell)}${ext}`, { type: take.type })], audioId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFetchingTake(null)
    }
  }, [projectId, session, addFiles])

  const totalSeconds = recordings.reduce((sum, r) => sum + (r.seconds ?? 0), 0)
  const probing = recordings.some((r) => r.seconds == null)
  const oversized = recordings.some((r) => r.file.size > CUSTOM_VOICE_MAX_CLIP_BYTES)
  const enough = totalSeconds >= ELEVENLABS_CLONE_MIN_SECONDS
  const great = totalSeconds >= ELEVENLABS_CLONE_RECOMMENDED_SECONDS
  const trimmedName = name.trim()
  const canStart = Boolean(trimmedName) && enough && !probing && !oversized && consent && !busy
    && canClone !== false && Boolean(projectId && session)

  const start = useCallback(async () => {
    if (!canStart || !projectId || !session) return
    setError(null)
    setPhase({ kind: "uploading", done: 0, total: recordings.length })
    try {
      const cloned = await cloneElevenLabsVoice({
        projectId,
        fileId,
        name: trimmedName,
        recordings: recordings.map((r) => r.file),
        removeBackgroundNoise: true,
        consentConfirmed: consent,
        onProgress: (done, total) => setPhase(done >= total ? { kind: "cloning" } : { kind: "uploading", done, total }),
      }, audioSyncTokenFetcherForSession(session))
      setPhase({ kind: "idle" })
      onCloned(cloned)
    } catch (e) {
      setError(categorizeAiError(e instanceof Error ? e.message : String(e)).body)
      setPhase({ kind: "idle" })
    }
  }, [canStart, projectId, session, recordings, fileId, trimmedName, consent, onCloned])

  return (
    <div className="space-y-3">
      {canClone === false && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs" role="status">
          {t("audio.elevenLabs.clonePlanNote")}
        </p>
      )}

      <div
        className={cn("rounded-xl border border-dashed transition-colors", dragging && "border-primary bg-primary/5")}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
      >
        <label className="flex cursor-pointer flex-col items-center gap-1 rounded-xl px-4 py-4 text-center hover:bg-accent/30">
          <Upload className="mb-1 size-4 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">{t("audio.train.addRecordings")}</span>
          <span className="text-[11px] text-muted-foreground">{t("audio.elevenLabs.cloneRecordingTips")}</span>
          <input
            type="file"
            accept="audio/*,video/*"
            multiple
            className="sr-only"
            aria-label={t("audio.train.addRecordingsAriaLabel")}
            disabled={busy}
            onChange={(e) => { addFiles(e.target.files); e.target.value = "" }}
          />
        </label>

        {takes.length > 0 && (
          <div className="space-y-1.5 border-t border-dashed px-3 py-2.5">
            <p className="text-center text-[11px] text-muted-foreground">{t("audio.elevenLabs.cloneFromLines")}</p>
            <ul className="flex max-h-24 flex-wrap justify-center gap-1 overflow-y-auto" aria-label={t("audio.elevenLabs.cloneFromLinesAriaLabel")}>
              {takes.map(({ cell, audioId }) => {
                const added = addedTakes.has(audioId)
                return (
                  <li key={`${cell.id}-${audioId}`}>
                    <button
                      type="button"
                      disabled={busy || added || fetchingTake !== null}
                      title={cell.cellLabel || undefined}
                      aria-pressed={added}
                      onClick={() => void addTake(cell, audioId)}
                      className={cn(
                        "inline-flex h-6 max-w-[14rem] items-center gap-1 rounded-full border px-2.5 text-[11px] text-muted-foreground transition-colors",
                        "hover:border-foreground/20 hover:text-foreground disabled:pointer-events-none",
                        added && "border-primary bg-primary/15 text-primary",
                      )}
                    >
                      {fetchingTake === audioId ? <Spinner className="size-3" /> : added ? <Check className="size-3" aria-hidden /> : null}
                      <span className="truncate">{lineSnippet(cell)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>

      {recordings.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <ul className="max-h-32 divide-y overflow-y-auto">
            {recordings.map((r, i) => (
              <li key={`${r.file.name}-${i}`} className="flex items-center gap-2 px-2.5 py-1 text-xs">
                <FileAudio className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{r.file.name}</span>
                {r.file.size > CUSTOM_VOICE_MAX_CLIP_BYTES ? (
                  <span className="text-destructive">{t("audio.train.fileTooLarge")}</span>
                ) : (
                  <span className="tabular-nums text-muted-foreground">{r.seconds == null ? "…" : fmt(r.seconds)}</span>
                )}
                <Button
                  type="button" variant="ghost" size="icon" className="size-6"
                  aria-label={t("audio.train.removeRecordingAriaLabel", { name: r.file.name })}
                  disabled={busy}
                  onClick={() => setRecordings((cur) => cur.filter((x) => x !== r))}
                >
                  <X className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex items-baseline justify-between gap-2 border-t bg-muted/40 px-2.5 py-1 text-[11px]">
            <span className={cn("tabular-nums font-medium", !enough && "text-amber-600 dark:text-amber-400")}>
              {t("audio.elevenLabs.cloneTotal", { duration: fmt(totalSeconds) })}
            </span>
            <span className="text-muted-foreground">
              {!enough
                ? t("audio.elevenLabs.cloneMinimumHint", { seconds: ELEVENLABS_CLONE_MIN_SECONDS })
                : great
                  ? t("audio.elevenLabs.cloneGreatHint")
                  : t("audio.elevenLabs.cloneRecommendedHint")}
            </span>
          </div>
        </div>
      )}

      <VoiceConsentBox id="elevenlabs-clone-consent" checked={consent} onCheckedChange={setConsent} />

      {error && <p className="select-text break-words text-xs text-destructive" role="alert">{error}</p>}
      {!trimmedName && <p className="text-[11px] text-muted-foreground">{t("audio.elevenLabs.cloneNameFirst")}</p>}

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" className="-ms-2.5 text-muted-foreground" disabled={busy} onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button type="button" disabled={!canStart} onClick={() => void start()}>
          {busy ? <Spinner className="size-3" /> : null}
          {phase.kind === "uploading"
            ? t("audio.train.uploading", { done: phase.done, total: phase.total })
            : phase.kind === "cloning"
              ? t("audio.elevenLabs.cloning")
              : t("audio.elevenLabs.cloneButton")}
        </Button>
      </div>
    </div>
  )
}
