// TrainVoicePanel — the "Train voice" tab of NewVoiceModal: build a custom voice
// from the organization's own recordings of a real person (an actor, a narrator).
// Pick recordings, confirm the speaker's consent on the organization's behalf,
// start training (~45 min on the voice forge). The cast gets the voice at once,
// marked "Training" until it is ready for Change voice.
//
// Consent is the organization's responsibility and the panel says so plainly:
// nothing starts until the maintainer ticks the statement, and the worker keeps
// that confirmation as an audit record.
import { useCallback, useState, type ReactNode } from "react"
import { FileAudio, ShieldCheck, Upload, X } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { probeDurationMsSafe } from "@/lib/import"
import {
  CUSTOM_VOICE_CONSENT_STATEMENT,
  CUSTOM_VOICE_MAX_CLIP_BYTES,
  CUSTOM_VOICE_MAX_CLIPS,
  CUSTOM_VOICE_MAX_MINUTES,
  CUSTOM_VOICE_MIN_MINUTES,
  CUSTOM_VOICE_RECOMMENDED_MINUTES,
  startCustomVoiceTraining,
  voiceFromCustomTraining,
} from "@/lib/audio/custom-voice"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import type { Voice } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

interface Recording {
  file: File
  /** null while probing, or when the browser can't decode it. */
  seconds: number | null
}

export interface TrainVoicePanelProps {
  /** The draft voice: its id, color and (user-typed) name become the cast voice. */
  draft: Pick<Voice, "id" | "name" | "color">
  /** Editing an existing trained voice: only the name can change. */
  editing?: boolean
  onNameChange: (name: string) => void
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  onStarted: (voice: Voice) => void
}

const fmt = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`

export function TrainVoicePanel(props: TrainVoicePanelProps) {
  const t = useT()
  const nameField = (
    <Field>
      <FieldLabel htmlFor="voice-name">{t("audio.train.speakerNameLabel")}</FieldLabel>
      <Input
        id="voice-name"
        value={props.draft.name}
        onChange={(e) => props.onNameChange(e.target.value)}
        className="h-10"
        placeholder={t("audio.train.speakerNamePlaceholder")}
        aria-label={t("audio.newVoice.nameAriaLabel")}
      />
    </Field>
  )
  if (props.editing) return nameField
  return <TrainVoiceForm {...props} nameField={nameField} />
}

function TrainVoiceForm({ draft, projectId, fileId, session, onStarted, nameField }: TrainVoicePanelProps & { nameField: ReactNode }) {
  const t = useT()
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [consent, setConsent] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return
    const added = Array.from(files).slice(0, CUSTOM_VOICE_MAX_CLIPS)
    setRecordings((cur) => [...cur, ...added.map((file) => ({ file, seconds: null }))].slice(0, CUSTOM_VOICE_MAX_CLIPS))
    for (const file of added) {
      void probeDurationMsSafe(file).then((ms) => {
        setRecordings((cur) => cur.map((r) => (r.file === file ? { ...r, seconds: ms == null ? 0 : ms / 1000 } : r)))
      })
    }
  }, [])

  const totalSeconds = recordings.reduce((sum, r) => sum + (r.seconds ?? 0), 0)
  const minutes = totalSeconds / 60
  const oversized = recordings.filter((r) => r.file.size > CUSTOM_VOICE_MAX_CLIP_BYTES)
  const probing = recordings.some((r) => r.seconds == null)
  const enough = minutes >= CUSTOM_VOICE_MIN_MINUTES
  const tooMuch = minutes > CUSTOM_VOICE_MAX_MINUTES
  const name = draft.name.trim()
  const canStart = Boolean(name) && enough && !tooMuch && !probing && oversized.length === 0 && consent
    && progress == null && Boolean(projectId && fileId && session)

  const start = useCallback(async () => {
    if (!canStart || !projectId || !fileId || !session) return
    setError(null)
    setProgress({ done: 0, total: recordings.length })
    try {
      const started = await startCustomVoiceTraining({
        projectId,
        fileId,
        speakerName: name,
        recordings: recordings.map((r) => r.file),
        consentConfirmed: consent,
        getSyncToken: audioSyncTokenFetcherForSession(session),
        onProgress: (done, total) => setProgress({ done, total }),
      })
      onStarted(voiceFromCustomTraining(started, {
        id: draft.id, name, color: draft.color, attestedByUsername: session.username ?? "",
      }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setProgress(null)
    }
  }, [canStart, projectId, fileId, session, recordings, name, consent, onStarted, draft.id, draft.color])

  const meterPct = Math.min(100, (minutes / CUSTOM_VOICE_RECOMMENDED_MINUTES) * 100)
  const [dragging, setDragging] = useState(false)

  return (
    <div className="space-y-4">
      {nameField}
      <p className="text-xs text-muted-foreground">{t("audio.train.intro")}</p>

      <div className="space-y-2">
        <label
          className={cn(
            "flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-5 text-center transition-colors",
            "hover:border-foreground/30 hover:bg-accent/30",
            dragging && "border-primary bg-primary/5",
          )}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
        >
          <span className="mb-1 grid size-9 place-items-center rounded-full bg-muted">
            <Upload className="size-4" />
          </span>
          <span className="text-sm font-medium">{t("audio.train.addRecordings")}</span>
          <span className="text-[11px] text-muted-foreground">{t("audio.train.recordingTips")}</span>
          <input
            type="file"
            accept="audio/*,video/*"
            multiple
            className="sr-only"
            aria-label={t("audio.train.addRecordingsAriaLabel")}
            onChange={(e) => { addFiles(e.target.files); e.target.value = "" }}
          />
        </label>

        {recordings.length > 0 && (
          <ul className="max-h-32 divide-y overflow-y-auto rounded-lg border">
            {recordings.map((r, i) => (
              <li key={`${r.file.name}-${i}`} className="flex items-center gap-2 px-2.5 py-1 text-xs">
                <FileAudio className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{r.file.name}</span>
                {r.file.size > CUSTOM_VOICE_MAX_CLIP_BYTES ? (
                  <span className="text-destructive">{t("audio.train.fileTooLarge")}</span>
                ) : (
                  <span className="tabular-nums text-muted-foreground">{r.seconds == null ? "…" : fmt(r.seconds)}</span>
                )}
                <Button
                  type="button" variant="ghost" size="icon" className="size-6"
                  aria-label={t("audio.train.removeRecordingAriaLabel", { name: r.file.name })}
                  disabled={progress != null}
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
              <span className={cn("tabular-nums font-medium", tooMuch ? "text-destructive" : enough ? "text-foreground" : "text-amber-600 dark:text-amber-400")}>
                {t("audio.train.audioMeter", { minutes: minutes.toFixed(1) })}
              </span>
              <span className="text-muted-foreground">
                {tooMuch
                  ? t("audio.train.tooMuchAudio", { max: CUSTOM_VOICE_MAX_MINUTES })
                  : enough
                    ? t("audio.train.recommendedHint", { recommended: CUSTOM_VOICE_RECOMMENDED_MINUTES })
                    : t("audio.train.minimumHint", { min: CUSTOM_VOICE_MIN_MINUTES })}
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

      <div className="space-y-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
        <p className="flex items-center gap-1.5 text-[13px] font-medium">
          <ShieldCheck className="size-4 text-amber-600 dark:text-amber-400" />
          {t("audio.train.consentTitle")}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("audio.train.consentBody")}</p>
        <details className="group text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none underline-offset-2 hover:underline">
            {t("audio.train.fullStatement")}
          </summary>
          <p className="mt-1.5 rounded-md bg-background/60 p-2 leading-relaxed" lang="en">{CUSTOM_VOICE_CONSENT_STATEMENT}</p>
        </details>
        {/* Not a wrapping <label>: around the Checkbox's own button, one click
            would toggle it twice. */}
        <div className="flex items-start gap-2 text-xs">
          <Checkbox
            id="train-voice-consent"
            checked={consent}
            onCheckedChange={(v) => setConsent(v === true)}
            aria-label={t("audio.train.consentCheckboxAriaLabel")}
            className="mt-0.5"
          />
          <label htmlFor="train-voice-consent" className="leading-relaxed">{t("audio.train.consentCheckbox")}</label>
        </div>
      </div>

      {error && <p className="select-text break-words text-xs text-destructive" role="alert">{error}</p>}

      <Button type="button" className="w-full" disabled={!canStart} onClick={() => void start()}>
        {progress ? <Spinner className="size-3" /> : null}
        {progress
          ? t("audio.train.uploading", { done: progress.done, total: progress.total })
          : t("audio.train.start")}
      </Button>
    </div>
  )
}
