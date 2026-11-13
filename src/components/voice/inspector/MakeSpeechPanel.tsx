// "Make speech" (AQU-2577): the recipe panel in the Voices rail.
//
// Three steps, set once per project on this device: translate a line that has
// no text yet, have a reader voice speak it, and change the result into a
// character's voice. Then run it on the selected line or on the lines that
// have no speech yet, and watch each line go through. The usual way to run it
// is one line at a time, from that line's ghost clip on the timeline.
//
// The panel owns the recipe and the progress list. The steps themselves are
// the workspace's (it has the cells, the session and the undo history), handed
// in as `actions`; the order they run in is make-speech.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Play, Square } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
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
  /** What names the line in the progress list: its text, or its source when it has none yet. */
  label: string
  hasSpeech: boolean
}

export interface MakeSpeechPanelProps {
  projectId: string
  voices: Voice[]
  /** The file's lines, in order. */
  lines: MakeSpeechLine[]
  /** The line selected in the editor, if any. */
  selectedCellId: string | null
  /** The language lines are translated into, as the lane names it. */
  targetLanguage?: string
  actions: MakeSpeechActions
  onBack: () => void
}

type Target = "line" | "missing"

const LINE_DEFAULT = "__line__"
const NO_CHARACTER = "__none__"

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
  projectId, voices, lines, selectedCellId, targetLanguage, actions, onBack,
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

  const missing = useMemo(() => lines.filter((l) => !l.hasSpeech).map((l) => l.cellId), [lines])
  const [target, setTarget] = useState<Target>(selectedCellId ? "line" : "missing")
  const targetIds = useMemo(
    () => (target === "line" ? (selectedCellId ? [selectedCellId] : []) : missing),
    [target, selectedCellId, missing],
  )

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
      }, abort.signal)
    } finally {
      setRunning(false)
    }
  }, [running, targetIds, effective, actions])

  const voiceItems = voices.map((v) => ({ value: v.id, label: v.name }))
  const readerItems = [{ value: LINE_DEFAULT, label: t("audio.makeSpeech.readerLineVoice") }, ...voiceItems]
  const characterItems = [{ value: NO_CHARACTER, label: t("audio.makeSpeech.noCharacter") }, ...voiceItems]
  const done = progress ? [...progress.values()].filter((s) => s.kind !== "waiting" && s.kind !== "running").length : 0
  const labelOf = (cellId: string) => lines.find((l) => l.cellId === cellId)?.label ?? cellId

  const targets: { value: Target; label: string; count: number }[] = [
    { value: "line", label: t("audio.makeSpeech.targetLine"), count: selectedCellId ? 1 : 0 },
    { value: "missing", label: t("audio.makeSpeech.targetMissing", { count: missing.length }), count: missing.length },
  ]

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="make-speech-panel" data-showcase="voice.make-speech">
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
      <div className="space-y-2.5 border-b p-3">
        <Step n={1} title={t("audio.makeSpeech.step1")}>
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
          <Select
            items={readerItems} value={reader ?? LINE_DEFAULT} disabled={running}
            onValueChange={(v) => { if (v) update({ readerVoiceId: v === LINE_DEFAULT ? null : v }) }}
          >
            <SelectTrigger aria-label={t("audio.makeSpeech.readerAriaLabel")} className="w-full min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {readerItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Step>

        <Step n={3} title={t("audio.makeSpeech.step3")} strong={character != null}>
          <Select
            items={characterItems} value={character ?? NO_CHARACTER} disabled={running}
            onValueChange={(v) => { if (v) update({ characterVoiceId: v === NO_CHARACTER ? null : v }) }}
          >
            <SelectTrigger aria-label={t("audio.makeSpeech.characterAriaLabel")} className="w-full min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {characterItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{t("audio.makeSpeech.characterNote")}</p>
        </Step>
      </div>

      <div className="space-y-2.5 border-b p-3">
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
        <p className="text-[11px] text-muted-foreground">{t("audio.makeSpeech.ghostHint")}</p>
        <p className="text-[11px] text-muted-foreground">{t("audio.makeSpeech.newTakeNote")}</p>
      </div>

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
