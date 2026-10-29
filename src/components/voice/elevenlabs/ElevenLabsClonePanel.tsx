// "Clone a voice" inside the ElevenLabs flow (AQU-2299): an Instant Voice
// Clone in the user's own ElevenLabs account, from recordings dropped here or
// takes picked from this project's lines. Same consent gate as Train voice —
// the organization confirms the speaker's consent and the worker keeps that
// confirmation as an audit record. ElevenLabs needs ~10 s at minimum and
// sounds best from a minute or two of clean speech.
import { useCallback, useMemo, useState } from "react"
import { FileAudio, ListMusic, Upload, X } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { VoiceInfoTip } from "@/components/voice/VoiceInfoTip"
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
}

const fmt = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`

export function ElevenLabsClonePanel({
  name, projectId, fileId, session, cells, canClone, onCloned,
}: ElevenLabsClonePanelProps) {
  const t = useT()
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [denoise, setDenoise] = useState(false)
  const [consent, setConsent] = useState(false)
  const [phase, setPhase] = useState<{ kind: "idle" } | { kind: "uploading"; done: number; total: number } | { kind: "cloning" }>({ kind: "idle" })
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const busy = phase.kind !== "idle"

  const addFiles = useCallback((files: ArrayLike<File> | null) => {
    if (!files) return
    const added = Array.from(files)
    setRecordings((cur) => [...cur, ...added.map((file) => ({ file, seconds: null }))].slice(0, ELEVENLABS_CLONE_MAX_CLIPS))
    for (const file of added) {
      void probeDurationMsSafe(file).then((ms) => {
        setRecordings((cur) => cur.map((r) => (r.file === file ? { ...r, seconds: ms == null ? 0 : ms / 1000 } : r)))
      })
    }
  }, [])

  const takes = useMemo(() => linesWithTakes(cells), [cells])
  const addTake = useCallback(async (cell: CellData, audioId: string) => {
    setPickerOpen(false)
    if (!projectId) return
    try {
      addFiles([await fetchTakeAsFile({ projectId, cell, audioId, session: session ?? null })])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
        removeBackgroundNoise: denoise,
        consentConfirmed: consent,
        onProgress: (done, total) => setPhase(done >= total ? { kind: "cloning" } : { kind: "uploading", done, total }),
      }, audioSyncTokenFetcherForSession(session))
      setPhase({ kind: "idle" })
      onCloned(cloned)
    } catch (e) {
      setError(categorizeAiError(e instanceof Error ? e.message : String(e)).body)
      setPhase({ kind: "idle" })
    }
  }, [canStart, projectId, session, recordings, fileId, trimmedName, denoise, consent, onCloned])

  const meterPct = Math.min(100, (totalSeconds / ELEVENLABS_CLONE_RECOMMENDED_SECONDS) * 100)

  return (
    <div className="space-y-3.5">
      {canClone === false && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs" role="status">
          {t("audio.elevenLabs.clonePlanNote")}
        </p>
      )}

      <div className="space-y-2">
        <label
          className={cn(
            "flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-4 text-center transition-colors",
            "hover:border-foreground/30 hover:bg-accent/30",
            dragging && "border-primary bg-primary/5",
          )}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
        >
          <span className="mb-1 grid size-8 place-items-center rounded-full bg-muted">
            <Upload className="size-4" aria-hidden />
          </span>
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
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger
              render={<Button type="button" variant="ghost" size="sm" className="w-full text-muted-foreground" disabled={busy} />}
            >
              <ListMusic /> {t("audio.elevenLabs.cloneFromLines")}
            </PopoverTrigger>
            <PopoverContent align="center" className="w-72 p-1">
              <ul className="max-h-60 overflow-y-auto" aria-label={t("audio.elevenLabs.cloneFromLinesAriaLabel")}>
                {takes.map(({ cell, audioId }) => (
                  <li key={`${cell.id}-${audioId}`}>
                    <button
                      type="button"
                      className="flex w-full flex-col rounded-md px-2 py-1.5 text-start hover:bg-accent"
                      onClick={() => void addTake(cell, audioId)}
                    >
                      <span className="truncate text-xs font-medium">{lineSnippet(cell)}</span>
                      {cell.cellLabel && (
                        <span className="truncate text-[11px] text-muted-foreground">{cell.cellLabel}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )}

        {recordings.length > 0 && (
          <ul className="max-h-32 divide-y overflow-y-auto rounded-lg border">
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
        )}

        {recordings.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-baseline justify-between text-[11px]">
              <span className={cn("tabular-nums font-medium", enough ? "text-foreground" : "text-amber-600 dark:text-amber-400")}>
                {fmt(totalSeconds)}
              </span>
              <span className="text-muted-foreground">
                {!enough
                  ? t("audio.elevenLabs.cloneMinimumHint", { seconds: ELEVENLABS_CLONE_MIN_SECONDS })
                  : great
                    ? t("audio.elevenLabs.cloneGreatHint")
                    : t("audio.elevenLabs.cloneRecommendedHint")}
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full transition-[width] duration-500", enough ? "bg-primary" : "bg-amber-500")}
                style={{ width: `${meterPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">{t("audio.elevenLabs.removeNoise")}</span>
          <VoiceInfoTip label={t("audio.elevenLabs.removeNoiseHelpAriaLabel")} content={t("audio.elevenLabs.removeNoiseHint")} />
        </div>
        <Switch size="sm" checked={denoise} onCheckedChange={(v) => setDenoise(v === true)} aria-label={t("audio.elevenLabs.removeNoise")} disabled={busy} />
      </div>

      <VoiceConsentBox id="elevenlabs-clone-consent" checked={consent} onCheckedChange={setConsent} />

      {error && <p className="select-text break-words text-xs text-destructive" role="alert">{error}</p>}

      <Button type="button" className="w-full" disabled={!canStart} onClick={() => void start()}>
        {busy ? <Spinner className="size-3" /> : null}
        {phase.kind === "uploading"
          ? t("audio.train.uploading", { done: phase.done, total: phase.total })
          : phase.kind === "cloning"
            ? t("audio.elevenLabs.cloning")
            : t("audio.elevenLabs.cloneButton")}
      </Button>
      {!trimmedName && <p className="text-center text-[11px] text-muted-foreground">{t("audio.elevenLabs.cloneNameFirst")}</p>}
    </div>
  )
}
