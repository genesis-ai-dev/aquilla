// "Make speech" (AQU-2577): the Voices rail's panel for making speech from
// text. Generating speech lives here and nowhere else.
//
// It runs on the selected lines (select on the timeline; Shift/⌘-click adds
// more, as does Shift-clicking an empty line's sparkle):
//
//   1 translate  automatic, for a line with no text; a person checks the
//                drafts before any speech is made
//   2 speak      one voice for every selected line
//   3 clone      optional: re-voice the take into a character's voice
//
// The panel owns the recipe (remembered per project on this device), the
// review and the progress list. The steps themselves are the workspace's,
// handed in as `actions`; the order they run in is make-speech.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Play, RotateCcw, Square } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { LineTagChips } from "./LineTagChips"
import { MakeSpeechReview, type MakeSpeechReviewLine } from "./MakeSpeechReview"
import {
  DEFAULT_ELEVENLABS_MODEL,
  ELEVENLABS_SPEED_MAX,
  ELEVENLABS_SPEED_MIN,
  elevenLabsModelReadsTags,
  elevenLabsSettingsOf,
} from "@/lib/audio/elevenlabs/settings"
import { voiceTakesLineDelivery } from "@/lib/audio/line-delivery"
import { voiceConversionKey } from "@/lib/audio/change-voice"
import {
  loadMakeSpeechRecipe,
  runMakeSpeech,
  saveMakeSpeechRecipe,
  translateMissing,
  type MakeSpeechActions,
  type MakeSpeechLineState,
  type MakeSpeechRecipe,
} from "@/lib/audio/make-speech"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { LineDelivery, Voice } from "@/lib/parsers/types"

export interface MakeSpeechLine {
  cellId: string
  /** What names the line in the lists: its text, or its source when it has none yet. */
  label: string
  /** The line's source text, shown beside its draft in the review. */
  source: string
  /** The line has target text; without it, step 1 translates it first. */
  hasText: boolean
  hasSpeech: boolean
  /** The voice cast on the line. */
  voiceId?: string
}

/** What the review needs on top of the steps: the drafted text, and a way to save an edit. */
export interface MakeSpeechTextActions {
  textOf(cellId: string): string
  saveText(cellId: string, text: string): Promise<void>
}

export interface MakeSpeechPanelProps {
  projectId: string
  voices: Voice[]
  /** The file's lines, in order. */
  lines: MakeSpeechLine[]
  /** The lines selected on the timeline, in file order. */
  selectedCellIds: readonly string[]
  /** Empty lines picked by their sparkle (Shift-click adds more). */
  picked?: readonly string[]
  actions: MakeSpeechActions & Partial<MakeSpeechTextActions>
  /**
   * Keep the delivery set here (speed, tags) on the lines it was run on, so the
   * clip inspector shows it afterwards. Absent: delivery is not offered.
   */
  onSaveDelivery?: (cellIds: readonly string[], delivery: LineDelivery) => Promise<void> | void
  /** Each line's state as the run goes, for whoever draws the lines (the timeline's sparkles). */
  onLineState?: (cellId: string, state: MakeSpeechLineState) => void
  onBack: () => void
}

const STATE_KEYS: Record<MakeSpeechLineState["kind"], MessageKey> = {
  waiting: "audio.makeSpeech.stateWaiting",
  running: "audio.makeSpeech.stateWaiting",
  done: "common.done",
  review: "audio.makeSpeech.stateReview",
  skipped: "audio.makeSpeech.stateSkipped",
  failed: "audio.makeSpeech.stateFailed",
}
const STEP_KEYS = {
  translate: "audio.makeSpeech.stepTranslating",
  speak: "audio.makeSpeech.stepSpeaking",
  revoice: "audio.makeSpeech.stepRevoicing",
} as const satisfies Record<string, MessageKey>

export function MakeSpeechPanel({
  projectId, voices, lines, selectedCellIds, picked, actions, onSaveDelivery, onLineState, onBack,
}: MakeSpeechPanelProps) {
  const t = useT()
  const [recipe, setRecipe] = useState<MakeSpeechRecipe>(() => loadMakeSpeechRecipe(projectId))
  const update = (patch: Partial<MakeSpeechRecipe>) => setRecipe((cur) => {
    const next = { ...cur, ...patch }
    saveMakeSpeechRecipe(projectId, next)
    return next
  })

  const byId = useMemo(() => new Map(lines.map((l) => [l.cellId, l])), [lines])
  // The selected lines and the picked ones, in file order.
  const targetIds = useMemo(() => {
    const chosen = new Set([...selectedCellIds, ...(picked ?? [])])
    return lines.filter((l) => chosen.has(l.cellId)).map((l) => l.cellId)
  }, [lines, selectedCellIds, picked])
  const untranslated = targetIds.filter((id) => byId.get(id)?.hasText === false).length

  // ── The voices ──
  // One voice reads every selected line: the last one chosen, else the first
  // line's own, else the project's first.
  const firstCast = targetIds.map((id) => byId.get(id)?.voiceId).find((id) => id && voices.some((v) => v.id === id))
  const reader = voices.some((v) => v.id === recipe.readerVoiceId)
    ? recipe.readerVoiceId
    : firstCast ?? voices[0]?.id ?? null
  // Only a trained voice or an ElevenLabs voice can take a clone; an Inworld
  // or Gemini voice can read text but cannot re-voice a take.
  const cloneable = useMemo(() => voices.filter((v) => voiceConversionKey(v) != null), [voices])
  const character = cloneable.some((v) => v.id === recipe.characterVoiceId && v.id !== reader)
    ? recipe.characterVoiceId
    : cloneable.find((v) => v.id !== reader)?.id ?? null
  const cloning = recipe.clone && character != null
  const effective = useMemo<MakeSpeechRecipe>(
    () => ({ readerVoiceId: reader, clone: cloning, characterVoiceId: character }),
    [reader, cloning, character],
  )

  // ── Delivery: how the reader says these lines ──
  const readerVoice = voices.find((v) => v.id === reader)
  const tunable = readerVoice && voiceTakesLineDelivery(readerVoice) ? readerVoice : null
  const readsTags = tunable ? elevenLabsModelReadsTags(tunable.elevenLabs?.modelId ?? DEFAULT_ELEVENLABS_MODEL) : true
  const [speed, setSpeed] = useState<number | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const ownSpeed = tunable ? elevenLabsSettingsOf(tunable).speed : 1
  const delivery = useMemo<LineDelivery | undefined>(
    () => (tunable && (speed != null || tags.length > 0)
      ? { settings: speed != null ? { speed } : {}, tags }
      : undefined),
    [tunable, speed, tags],
  )

  // ── The run ──
  const [progress, setProgress] = useState<Map<string, MakeSpeechLineState> | null>(null)
  const [running, setRunning] = useState(false)
  const [review, setReview] = useState<MakeSpeechReviewLine[] | null>(null)
  const reviewDone = useRef<((texts: Map<string, string> | null) => void) | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => () => {
    abortRef.current?.abort()
    reviewDone.current?.(null)
  }, [])

  const run = useCallback(async () => {
    if (running || targetIds.length === 0) return
    const abort = new AbortController()
    abortRef.current = abort
    setRunning(true)
    setProgress(new Map())
    panelRef.current?.scrollTo({ top: 0, behavior: "smooth" })
    const failed = new Set<string>()
    const setLine = (cellId: string, state: MakeSpeechLineState) => {
      if (state.kind === "failed") failed.add(cellId)
      setProgress((cur) => new Map(cur ?? []).set(cellId, state))
      onLineState?.(cellId, state)
    }
    try {
      // 1. Translate the lines with no text, then let a person check the drafts.
      const drafted = await translateMissing(targetIds, actions, setLine, abort.signal)
      if (drafted.length > 0 && actions.textOf && actions.saveText) {
        const textOf = actions.textOf
        const texts = await new Promise<Map<string, string> | null>((resolve) => {
          reviewDone.current = resolve
          setReview(drafted.map((cellId) => ({ cellId, source: byId.get(cellId)?.source ?? "", text: textOf(cellId) })))
        })
        reviewDone.current = null
        setReview(null)
        if (!texts || abort.signal.aborted) return
        for (const [cellId, text] of texts) {
          if (text.trim() === textOf(cellId).trim()) continue
          try {
            await actions.saveText(cellId, text.trim())
          } catch (e) {
            setLine(cellId, { kind: "failed", step: "translate", reason: e instanceof Error ? e.message : String(e) })
          }
        }
      }
      // 2 and 3. Speak, then clone.
      if (delivery) await Promise.resolve(onSaveDelivery?.(targetIds, delivery)).catch(() => {})
      await runMakeSpeech(targetIds.filter((id) => !failed.has(id)), { ...effective, delivery }, actions, setLine, abort.signal)
    } finally {
      setRunning(false)
    }
  }, [running, targetIds, effective, delivery, actions, byId, onSaveDelivery, onLineState])

  const done = progress ? [...progress.values()].filter((s) => s.kind !== "waiting" && s.kind !== "running").length : 0
  const labelOf = (cellId: string) => byId.get(cellId)?.label ?? cellId

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden" data-testid="make-speech-panel" data-showcase="voice.make-speech">
      <div className="flex items-center gap-2 border-b p-3">
        <Button type="button" variant="outline" size="icon-sm" aria-label={t("audio.inspector.backToVoices")} onClick={onBack}>
          <ArrowLeft />
        </Button>
        <h2 className="text-sm font-semibold">{t("audio.makeSpeech.title")}</h2>
      </div>

      {progress && progress.size > 0 && (
        <div className="space-y-2 border-b p-3" data-testid="make-speech-progress">
          <div className="flex items-baseline justify-between text-xs">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("audio.makeSpeech.progress")}</h3>
            <span className="tabular-nums text-muted-foreground">{t("audio.makeSpeech.progressCount", { done, total: progress.size })}</span>
          </div>
          <div
            role="progressbar" aria-label={t("audio.makeSpeech.progress")} aria-valuemin={0} aria-valuemax={progress.size} aria-valuenow={done}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${progress.size ? (done / progress.size) * 100 : 0}%` }} />
          </div>
          <ul className="divide-y text-xs">
            {[...progress.entries()].map(([cellId, state]) => (
              <li key={cellId} className="space-y-0.5 py-1.5">
                <div className="flex items-center gap-2">
                  <span dir="auto" className="min-w-0 flex-1 truncate">{labelOf(cellId)}</span>
                  <span
                    className={cn(
                      "shrink-0",
                      state.kind === "done" ? "font-medium text-emerald-700 dark:text-emerald-400"
                        : state.kind === "failed" ? "font-medium text-destructive"
                          : state.kind === "running" ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {state.kind === "running" ? t(STEP_KEYS[state.step]) : t(STATE_KEYS[state.kind])}
                  </span>
                </div>
                {state.kind === "failed" && (
                  <p className="break-words text-[11px] text-destructive" data-testid="make-speech-failure">
                    {t(STEP_KEYS[state.step])}: {state.reason ?? t("audio.makeSpeech.noReason")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The lines this runs on. */}
      <div className="space-y-2 border-b p-3">
        {targetIds.length > 0 ? (
          <>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("audio.makeSpeech.selectedCount", { count: targetIds.length })}
            </h3>
            <ul className="max-h-32 divide-y overflow-y-auto rounded-lg border text-xs" data-testid="make-speech-picked">
              {targetIds.map((id) => (
                <li key={id} className="px-2 py-1.5">
                  <span dir="auto" className="block truncate">{labelOf(id)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="make-speech-none">{t("audio.makeSpeech.noLines")}</p>
        )}
        <p className="text-[11px] text-muted-foreground">{t("audio.makeSpeech.shiftHint")}</p>
      </div>

      <div className="space-y-2.5 border-b p-3">
        <Step n={1} title={t("audio.makeSpeech.step1")}>
          <p className="text-xs text-muted-foreground" data-testid="make-speech-translate-note">
            {untranslated === 0
              ? t("audio.makeSpeech.translateNone")
              : t("audio.makeSpeech.translateSome", { count: untranslated })}
          </p>
        </Step>

        <Step n={2} title={t("audio.makeSpeech.step2")}>
          <VoiceChips
            ariaLabel={t("audio.makeSpeech.readerAriaLabel")}
            voices={voices} value={reader} disabled={running}
            onPick={(voiceId) => update({ readerVoiceId: voiceId })}
          />
          {onSaveDelivery && tunable && (
            <div className="space-y-2.5 border-t pt-2.5" data-testid="make-speech-delivery">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium">{t("audio.elevenLabs.speed")}</span>
                  <span className="flex items-center gap-1 tabular-nums text-muted-foreground">
                    {speed == null ? t("audio.makeSpeech.speedOwn") : `${speed.toFixed(2)}×`}
                    {speed != null && (
                      <button
                        type="button" disabled={running} aria-label={t("audio.makeSpeech.speedReset")}
                        className="grid size-5 place-items-center rounded hover:bg-accent hover:text-foreground"
                        onClick={() => setSpeed(null)}
                      >
                        <RotateCcw className="size-3" aria-hidden />
                      </button>
                    )}
                  </span>
                </div>
                <Slider
                  min={ELEVENLABS_SPEED_MIN} max={ELEVENLABS_SPEED_MAX} step={0.05} disabled={running}
                  value={[speed ?? ownSpeed]}
                  onValueChange={(next) => {
                    const value = Array.isArray(next) ? next[0] : next
                    if (typeof value === "number") setSpeed(Math.round(value * 100) / 100)
                  }}
                  aria-label={t("audio.elevenLabs.speed")}
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium">{t("audio.makeSpeech.tags")}</p>
                <LineTagChips tags={tags} disabled={running} onChange={setTags} testId="make-speech-tags" />
                <p className="text-[11px] text-muted-foreground">
                  {readsTags ? t("audio.inspector.tagsNote") : t("audio.makeSpeech.tagsSomeSkipped")}
                </p>
              </div>
            </div>
          )}
        </Step>

        <Step
          n={3} title={t("audio.makeSpeech.step3")} strong={cloning}
          action={(
            <Switch
              size="sm"
              aria-label={t("audio.makeSpeech.cloneToggle")}
              checked={cloning}
              disabled={running || character == null}
              onCheckedChange={(on) => update({ clone: on, ...(on && character ? { characterVoiceId: character } : {}) })}
              data-testid="make-speech-clone-toggle"
            />
          )}
        >
          {character == null ? (
            <p className="text-[11px] text-muted-foreground">{t("audio.makeSpeech.cloneNoVoices")}</p>
          ) : cloning ? (
            <VoiceChips
              ariaLabel={t("audio.makeSpeech.characterAriaLabel")}
              voices={cloneable.filter((v) => v.id !== reader)} value={character} disabled={running}
              onPick={(voiceId) => update({ characterVoiceId: voiceId })}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">{t("audio.makeSpeech.cloneOff")}</p>
          )}
        </Step>
      </div>

      <div className="space-y-2 p-3">
        {running ? (
          <Button type="button" variant="outline" className="w-full" onClick={() => { abortRef.current?.abort(); reviewDone.current?.(null) }}>
            <Square data-icon="inline-start" />
            {t("common.stop")}
          </Button>
        ) : (
          <Button type="button" className="w-full" disabled={targetIds.length === 0 || reader == null} onClick={() => void run()} data-testid="make-speech-run">
            <Play data-icon="inline-start" />
            {t("audio.makeSpeech.run", { count: targetIds.length })}
          </Button>
        )}
        <p className="text-[11px] text-muted-foreground">{t("audio.makeSpeech.newTakeNote")}</p>
      </div>

      {review && (
        <MakeSpeechReview
          lines={review}
          onConfirm={(texts) => reviewDone.current?.(texts)}
          onCancel={() => reviewDone.current?.(null)}
        />
      )}
    </div>
  )
}

/** One voice out of the project's, picked by a click. */
function VoiceChips({ ariaLabel, voices, value, disabled, onPick }: {
  ariaLabel: string
  voices: Voice[]
  value: string | null
  disabled: boolean
  onPick: (voiceId: string) => void
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {voices.map((voice) => (
        <button
          key={voice.id} type="button" aria-pressed={value === voice.id} disabled={disabled}
          className={cn(
            "flex h-7 max-w-full items-center gap-1.5 rounded-full border ps-1 pe-2.5 text-xs disabled:opacity-50",
            value === voice.id ? "border-primary bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent",
          )}
          onClick={() => onPick(voice.id)}
        >
          <VoiceAvatar voice={voice} size={20} className="rounded-full" />
          <span className="truncate">{voice.name}</span>
        </button>
      ))}
    </div>
  )
}

function Step({ n, title, strong, action, children }: {
  n: number
  title: string
  strong?: boolean
  /** A control at the end of the step's title row (the clone toggle). */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className={cn("space-y-2 rounded-xl border p-2.5", strong && "border-primary/60 bg-primary/5")}>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
            strong ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {n}
        </span>
        <span className="flex-1 text-xs font-semibold">{title}</span>
        {action}
      </div>
      {children}
    </div>
  )
}
