// "Make speech" (AQU-2577): the panel the Voices rail shows for lines that
// have no speech yet.
//
// It is the whole pipeline, read top to bottom, for the lines picked:
//
//   the text  →  1 translate it  →  2 a reader speaks it  →  3 change it into
//   a character's voice
//
// Each step is one row: what it will do to these lines, and the one choice it
// needs (a voice), made by clicking a chip. Then one button. Nothing is
// generated until that button is pressed.
//
// The lines come from the timeline: a click on a line's ghost clip picks it,
// and Shift-click adds more. Opened from the roster instead, with nothing
// picked, the panel offers the selected line or every line with no speech.
//
// The panel owns the recipe (remembered per project on this device) and the
// progress list. The steps themselves are the workspace's, handed in as
// `actions`; the order they run in is make-speech.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Play, Square } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import {
  loadMakeSpeechRecipe,
  runMakeSpeech,
  saveMakeSpeechRecipe,
  type MakeSpeechActions,
  type MakeSpeechLineState,
  type MakeSpeechRecipe,
} from "@/lib/audio/make-speech"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { Voice } from "@/lib/parsers/types"

export interface MakeSpeechLine {
  cellId: string
  /** What names the line in the lists: its text, or its source when it has none yet. */
  label: string
  /** The line has target text; without it, step 1 translates it first. */
  hasText: boolean
  hasSpeech: boolean
}

export interface MakeSpeechPanelProps {
  projectId: string
  voices: Voice[]
  /** The file's lines, in order. */
  lines: MakeSpeechLine[]
  /** The line selected in the editor, if any. */
  selectedCellId: string | null
  /**
   * The lines picked on the timeline (their ghost clips). When there are any,
   * the panel is about exactly these lines and offers no other choice of lines.
   */
  picked?: readonly string[]
  /** The language lines are translated into, as a person reads it ("Arabic"). */
  targetLanguage?: string
  actions: MakeSpeechActions
  /** Each line's state as the run goes, for whoever draws the lines (the timeline's ghosts). */
  onLineState?: (cellId: string, state: MakeSpeechLineState) => void
  onBack: () => void
}

type Target = "line" | "missing"

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
  projectId, voices, lines, selectedCellId, picked, targetLanguage, actions, onLineState, onBack,
}: MakeSpeechPanelProps) {
  const t = useT()
  const [recipe, setRecipe] = useState<MakeSpeechRecipe>(() => loadMakeSpeechRecipe(projectId))
  const update = (patch: Partial<MakeSpeechRecipe>) => setRecipe((cur) => {
    const next = { ...cur, ...patch }
    saveMakeSpeechRecipe(projectId, next)
    return next
  })
  // A voice that was deleted since the recipe was saved is no voice at all.
  const reader = voices.some((v) => v.id === recipe.readerVoiceId) ? recipe.readerVoiceId : null
  const character = voices.some((v) => v.id === recipe.characterVoiceId) ? recipe.characterVoiceId : null
  const effective = useMemo<MakeSpeechRecipe>(
    () => ({ ...recipe, readerVoiceId: reader, characterVoiceId: character }),
    [recipe, reader, character],
  )

  const byId = useMemo(() => new Map(lines.map((l) => [l.cellId, l])), [lines])
  const missing = useMemo(() => lines.filter((l) => !l.hasSpeech).map((l) => l.cellId), [lines])
  const pickedIds = useMemo(() => (picked ?? []).filter((id) => byId.has(id)), [picked, byId])
  const hasPicked = pickedIds.length > 0
  const [target, setTarget] = useState<Target>(selectedCellId ? "line" : "missing")
  const targetIds = useMemo(
    () => (hasPicked ? pickedIds : target === "line" ? (selectedCellId ? [selectedCellId] : []) : missing),
    [hasPicked, pickedIds, target, selectedCellId, missing],
  )
  // What step 1 will do to these lines.
  const untranslated = targetIds.filter((id) => byId.get(id)?.hasText === false).length

  const [progress, setProgress] = useState<Map<string, MakeSpeechLineState> | null>(null)
  const [running, setRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => () => abortRef.current?.abort(), [])
  const run = useCallback(async () => {
    if (running || targetIds.length === 0) return
    const abort = new AbortController()
    abortRef.current = abort
    setRunning(true)
    setProgress(new Map())
    // Progress is at the top of the panel; the button that started it is at the bottom.
    panelRef.current?.scrollTo({ top: 0, behavior: "smooth" })
    try {
      await runMakeSpeech(targetIds, effective, actions, (cellId, state) => {
        setProgress((cur) => new Map(cur ?? []).set(cellId, state))
        onLineState?.(cellId, state)
      }, abort.signal)
    } finally {
      setRunning(false)
    }
  }, [running, targetIds, effective, actions, onLineState])

  const done = progress ? [...progress.values()].filter((s) => s.kind !== "waiting" && s.kind !== "running").length : 0
  const labelOf = (cellId: string) => byId.get(cellId)?.label ?? cellId

  const targets: { value: Target; label: string; count: number }[] = [
    { value: "line", label: t("audio.makeSpeech.targetLine"), count: selectedCellId ? 1 : 0 },
    { value: "missing", label: t("audio.makeSpeech.targetMissing", { count: missing.length }), count: missing.length },
  ]

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden" data-testid="make-speech-panel" data-showcase="voice.make-speech">
      <div className="space-y-1 border-b p-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon-sm" aria-label={t("audio.inspector.backToVoices")} onClick={onBack}>
            <ArrowLeft />
          </Button>
          <h2 className="text-sm font-semibold">{t("audio.makeSpeech.title")}</h2>
        </div>
        <p className="text-xs text-muted-foreground">{t("audio.makeSpeech.intro")}</p>
      </div>

      {progress && (
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
              <li key={cellId} className="flex items-center gap-2 py-1.5">
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
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The lines this is about. */}
      <div className="space-y-2 border-b p-3">
        {hasPicked ? (
          <>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("audio.makeSpeech.pickedCount", { count: pickedIds.length })}
            </h3>
            <ul className="max-h-32 divide-y overflow-y-auto rounded-lg border text-xs" data-testid="make-speech-picked">
              {pickedIds.map((id) => (
                <li key={id} className="flex items-center gap-2 px-2 py-1.5">
                  <span dir="auto" className="min-w-0 flex-1 truncate">{labelOf(id)}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-muted-foreground">{t("audio.makeSpeech.shiftHint")}</p>
          </>
        ) : (
          <>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("audio.makeSpeech.runOn")}</h3>
            <div role="group" aria-label={t("audio.makeSpeech.runOn")} className="flex flex-col overflow-hidden rounded-lg border text-xs">
              {targets.map((option, i) => (
                <button
                  key={option.value} type="button" aria-pressed={target === option.value}
                  disabled={running || option.count === 0}
                  className={cn(
                    "h-8 px-2.5 text-start disabled:opacity-40",
                    i > 0 && "border-t",
                    target === option.value ? "bg-foreground font-medium text-background" : "hover:bg-accent",
                  )}
                  onClick={() => setTarget(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{t("audio.makeSpeech.ghostHint")}</p>
          </>
        )}
      </div>

      {/* The pipeline, in the order it runs. */}
      <div className="space-y-2.5 border-b p-3">
        <Step n={1} title={t("audio.makeSpeech.step1")}>
          <p className="text-xs text-muted-foreground" data-testid="make-speech-translate-note">
            {untranslated === 0
              ? t("audio.makeSpeech.translateNone")
              : !recipe.translate
                ? t("audio.makeSpeech.translateSkipped", { count: untranslated })
                : t("audio.makeSpeech.translateSome", { count: untranslated })}
          </p>
          <label className="flex items-start gap-2 text-xs">
            <Checkbox checked={recipe.translate} onCheckedChange={(v) => update({ translate: v === true })} disabled={running} />
            <span>{targetLanguage ? t("audio.makeSpeech.translateInto", { language: targetLanguage }) : t("audio.makeSpeech.translate")}</span>
          </label>
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={recipe.reviewTranslation} disabled={running || !recipe.translate}
              onCheckedChange={(v) => update({ reviewTranslation: v === true })}
            />
            <span>{t("audio.makeSpeech.review")}</span>
          </label>
        </Step>

        <Step n={2} title={t("audio.makeSpeech.step2")}>
          <VoiceChips
            ariaLabel={t("audio.makeSpeech.readerAriaLabel")}
            voices={voices} value={reader} disabled={running}
            noneLabel={t("audio.makeSpeech.readerLineVoice")}
            onPick={(voiceId) => update({ readerVoiceId: voiceId })}
          />
        </Step>

        <Step n={3} title={t("audio.makeSpeech.step3")} strong={character != null}>
          <VoiceChips
            ariaLabel={t("audio.makeSpeech.characterAriaLabel")}
            voices={voices} value={character} disabled={running}
            noneLabel={t("audio.makeSpeech.noCharacter")}
            onPick={(voiceId) => update({ characterVoiceId: voiceId })}
          />
          <p className="text-[11px] text-muted-foreground">{t("audio.makeSpeech.characterNote")}</p>
        </Step>
      </div>

      <div className="space-y-2 p-3">
        {running ? (
          <Button type="button" variant="outline" className="w-full" onClick={() => abortRef.current?.abort()}>
            <Square data-icon="inline-start" />
            {t("common.stop")}
          </Button>
        ) : (
          <Button type="button" className="w-full" disabled={targetIds.length === 0} onClick={() => void run()} data-testid="make-speech-run">
            <Play data-icon="inline-start" />
            {t("audio.makeSpeech.run", { count: targetIds.length })}
          </Button>
        )}
        <p className="text-[11px] text-muted-foreground">{t("audio.makeSpeech.newTakeNote")}</p>
      </div>
    </div>
  )
}

/** One voice out of the project's, picked by a click; the first chip is "none of them". */
function VoiceChips({ ariaLabel, voices, value, noneLabel, disabled, onPick }: {
  ariaLabel: string
  voices: Voice[]
  value: string | null
  noneLabel: string
  disabled: boolean
  onPick: (voiceId: string | null) => void
}) {
  const chip = (selected: boolean) => cn(
    "flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs disabled:opacity-50",
    selected ? "border-primary bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent",
  )
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      <button type="button" aria-pressed={value == null} disabled={disabled} className={chip(value == null)} onClick={() => onPick(null)}>
        <span className="truncate">{noneLabel}</span>
      </button>
      {voices.map((voice) => (
        <button
          key={voice.id} type="button" aria-pressed={value === voice.id} disabled={disabled}
          className={cn(chip(value === voice.id), "ps-1")}
          onClick={() => onPick(voice.id)}
        >
          <VoiceAvatar voice={voice} size={20} className="rounded-full" />
          <span className="truncate">{voice.name}</span>
        </button>
      ))}
    </div>
  )
}

function Step({ n, title, strong, children }: { n: number; title: string; strong?: boolean; children: React.ReactNode }) {
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
        <span className="text-xs font-semibold">{title}</span>
      </div>
      {children}
    </div>
  )
}
