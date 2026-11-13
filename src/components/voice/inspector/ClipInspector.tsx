// The clip inspector (AQU-2577): what the Voices rail shows while a speech clip
// is selected in the Media view.
//
// One take, top to bottom: what it is and how it was made (recorded, spoken by
// a voice, changed into a character); how the line is delivered — speed,
// stability, expressiveness, closeness, and the tags it is spoken with — with
// "Hear it first" and "Regenerate this line"; and the voice itself.
//
// Delivery is the line's own (line-delivery.ts) unless "All <voice> lines" is
// picked, which edits the voice. Tags are always the line's. Both apply to
// ElevenLabs voices; for any other voice the section says so and stays out of
// the way.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Mic, Pause, Play, Plus, RefreshCw } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { categorizeAiError } from "@/lib/audio/ai-error"
import {
  DEFAULT_ELEVENLABS_MODEL,
  ELEVENLABS_MODELS,
  ELEVENLABS_SPEED_MAX,
  ELEVENLABS_SPEED_MIN,
  elevenLabsLanguageCode,
  elevenLabsModelReadsTags,
  elevenLabsSettingsOf,
} from "@/lib/audio/elevenlabs/settings"
import {
  lineDeliveryFor,
  lineDeliveryPatch,
  MAX_LINE_TAGS,
  normalizeLineTag,
  SUGGESTED_LINE_TAGS,
  voiceTakesLineDelivery,
  withLineDelivery,
} from "@/lib/audio/line-delivery"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { takeStory } from "@/lib/audio/take-story"
import { resolveCastVoice } from "@/lib/audio/voices"
import { ELEVENLABS_PROJECT_SCOPE_FILE_ID, previewElevenLabsTts } from "@/lib/sync/elevenlabs"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { ElevenLabsVoiceSettings, LineDelivery, ProjectTtsSettings, Voice } from "@/lib/parsers/types"

type Knob = "speed" | "stability" | "style" | "similarityBoost"

const KNOBS: readonly { key: Knob; labelKey: MessageKey; min: number; max: number }[] = [
  { key: "speed", labelKey: "audio.elevenLabs.speed", min: ELEVENLABS_SPEED_MIN, max: ELEVENLABS_SPEED_MAX },
  { key: "stability", labelKey: "audio.elevenLabs.stability", min: 0, max: 1 },
  { key: "style", labelKey: "audio.inspector.expressiveness", min: 0, max: 1 },
  { key: "similarityBoost", labelKey: "audio.inspector.closeness", min: 0, max: 1 },
]

const formatKnob = (key: Knob, v: number) => (key === "speed" ? `${v.toFixed(2)}×` : `${Math.round(v * 100)}%`)
const clock = (ms: number | null | undefined) => {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** The knobs of `next` that differ from the voice's own: what the line stores. */
function ownKnobs(next: ElevenLabsVoiceSettings, base: ElevenLabsVoiceSettings): Partial<ElevenLabsVoiceSettings> {
  const own: Partial<ElevenLabsVoiceSettings> = {}
  for (const { key } of KNOBS) if (Math.abs(next[key] - base[key]) > 0.001) own[key] = next[key]
  return own
}

export interface ClipInspectorProps {
  cell: CellData
  audioId: string
  /** The lane's voices, cast and line deliveries. */
  settings: ProjectTtsSettings | undefined
  /** The whole library: a voice edit writes all of it back (AQU-2037). */
  allVoices: Voice[]
  /** The lane's own voices, for "Use a different voice". */
  voices: Voice[]
  projectId: string
  fileId: string
  session: FrontierSession | null
  /** The lane's language, sent to the engine where the model takes one. */
  language?: string
  /** Voices and deliveries may be changed (maintainer, or a lead on this lane). */
  canEdit: boolean
  /** The line is being generated or re-voiced right now. */
  busy: boolean
  onBack: () => void
  onSaveSettings: (patch: Partial<ProjectTtsSettings>) => Promise<void> | void
  /** The take's audio, to play it here. */
  loadTake: (att: CodexCellAttachment) => Promise<Blob>
  /** Speak the line again (and change it into the character again, when the take was). */
  onRegenerate: () => void
  /** Cast another voice on this line; the workspace re-voices or reads as it does for any pick. */
  onPickVoice: (voiceId: string) => void
  /** Train a voice from this take. Absent when it is not a person's recording, or not allowed. */
  onTrainFromTake?: () => void
  onAddVoice: () => void
}

export function ClipInspector({
  cell, audioId, settings, allVoices, voices, projectId, fileId, session, language, canEdit, busy,
  onBack, onSaveSettings, loadTake, onRegenerate, onPickVoice, onTrainFromTake, onAddVoice,
}: ClipInspectorProps) {
  const t = useT()
  const att = cell.attachments?.[audioId]
  const story = useMemo(() => takeStory(cell, audioId, settings), [cell, audioId, settings])
  const lineVoice = resolveCastVoice(settings, cell, cell.ttsSettings?.voiceId)
  // The voice whose delivery this is: the one that read the text, else the line's.
  const speaker = story?.reader ?? lineVoice
  const tunable = voiceTakesLineDelivery(speaker)
  const base = elevenLabsSettingsOf(speaker)
  const stored = lineDeliveryFor(settings, cell.id)
  const modelId = speaker.elevenLabs?.modelId ?? DEFAULT_ELEVENLABS_MODEL
  const modelName = ELEVENLABS_MODELS.find((m) => m.id === modelId)?.name ?? modelId
  const readsTags = elevenLabsModelReadsTags(modelId)
  const text = (cell.translated ?? "").trim()

  // ── Delivery: a local draft, saved shortly after the last change ──
  const [scope, setScope] = useState<"line" | "voice">("line")
  const [draft, setDraft] = useState<ElevenLabsVoiceSettings | null>(null)
  const shown = draft ?? (scope === "line" ? { ...base, ...(stored?.settings ?? {}) } : base)
  // The host keys this component by clip, so a draft never outlives its line;
  // a change of scope drops it where the scope is set.

  const save = useCallback(async (next: ElevenLabsVoiceSettings) => {
    if (scope === "line") {
      await onSaveSettings(lineDeliveryPatch(settings, cell.id, { ...stored, settings: ownKnobs(next, base) }))
      return
    }
    // The voice takes the settings, and this line stops overriding them.
    await onSaveSettings({
      voices: allVoices.map((v) => (v.id === speaker.id && v.elevenLabs ? { ...v, elevenLabs: { ...v.elevenLabs, settings: next } } : v)),
      ...lineDeliveryPatch(settings, cell.id, stored ? { ...stored, settings: {} } : null),
    })
  }, [scope, onSaveSettings, settings, cell.id, stored, base, allVoices, speaker.id])
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save }, [save])
  useEffect(() => {
    if (!draft) return
    const timer = setTimeout(() => void saveRef.current(draft), 500)
    return () => clearTimeout(timer)
  }, [draft])
  /** Save a pending change now, before something reads the stored settings. */
  const flush = useCallback(async () => {
    if (draft) await saveRef.current(draft)
  }, [draft])

  // ── Tags: always this line's ──
  const tags = stored?.tags ?? []
  const [customTag, setCustomTag] = useState<string | null>(null)
  const setTags = (next: string[]) =>
    void onSaveSettings(lineDeliveryPatch(settings, cell.id, { ...stored, tags: next.slice(0, MAX_LINE_TAGS) }))
  const toggleTag = (tag: string) => setTags(tags.includes(tag) ? tags.filter((x) => x !== tag) : [...tags, tag])
  const addCustomTag = () => {
    const tag = normalizeLineTag(customTag ?? "")
    if (tag && !tags.includes(tag)) setTags([...tags, tag])
    setCustomTag(null)
  }
  const useTagModel = () =>
    void onSaveSettings({
      voices: allVoices.map((v) => (v.id === speaker.id && v.elevenLabs ? { ...v, elevenLabs: { ...v.elevenLabs, modelId: "eleven_v4" } } : v)),
    })

  // ── Playing: the take itself, or a preview of the current delivery ──
  const [playing, setPlaying] = useState<"take" | "preview" | null>(null)
  const [loading, setLoading] = useState<"take" | "preview" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const stop = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
    setPlaying(null)
    setLoading(null)
  }, [])
  useEffect(() => stop, [stop, cell.id, audioId])
  const play = useCallback(async (which: "take" | "preview", fetchBlob: () => Promise<Blob>) => {
    const wasPlaying = playing
    stop()
    if (wasPlaying === which) return
    setError(null)
    setLoading(which)
    try {
      const url = URL.createObjectURL(await fetchBlob())
      urlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => stop()
      setLoading(null)
      setPlaying(which)
      await audio.play().catch(() => stop())
    } catch (e) {
      setLoading(null)
      setError(categorizeAiError(e instanceof Error ? e.message : String(e)).body)
    }
  }, [playing, stop])

  const hearItFirst = () => void play("preview", async () => {
    if (!session || !speaker.elevenLabs) throw new Error("ElevenLabs (no key): connect your ElevenLabs API key to use this voice.")
    const delivery: LineDelivery = { ...stored, settings: scope === "line" ? ownKnobs(shown, base) : {} }
    const spoken = withLineDelivery(scope === "line" ? speaker : { ...speaker, elevenLabs: { ...speaker.elevenLabs, settings: shown } }, text, delivery)
    const languageCode = elevenLabsLanguageCode(language)
    return previewElevenLabsTts({
      projectId,
      fileId: fileId || ELEVENLABS_PROJECT_SCOPE_FILE_ID,
      text: spoken.text,
      voiceId: speaker.elevenLabs.voiceId,
      modelId,
      voiceSettings: elevenLabsSettingsOf(spoken.voice),
      ...(languageCode ? { languageCode } : {}),
    }, audioSyncTokenFetcherForSession(session))
  })

  if (!att || !story) {
    return (
      <div className="flex h-full flex-col gap-3 p-3" data-testid="clip-inspector">
        <BackRow onBack={onBack} label={t("audio.inspector.title")} />
        <p className="text-xs text-muted-foreground">{t("audio.inspector.takeGone")}</p>
      </div>
    )
  }

  const takeVoice = story.character ?? story.reader
  const title = att.label?.trim() || t("audio.takesStrip.takeFallback")
  const otherVoices = voices.filter((v) => v.id !== lineVoice.id)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="clip-inspector" data-showcase="voice.inspector">
      <div className="space-y-2.5 border-b p-3">
        <BackRow onBack={onBack} label={t("audio.inspector.title")} />
        <div className="flex items-center gap-2.5">
          {takeVoice
            ? <VoiceAvatar voice={takeVoice} size={34} />
            : <span className="grid size-[34px] shrink-0 place-items-center rounded-md bg-muted"><Mic className="size-4" aria-hidden /></span>}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" data-testid="clip-inspector-title">{title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {takeVoice?.name ?? (story.recordedBy ? t("audio.inspector.recordedBy", { name: story.recordedBy }) : t("audio.inspector.recording"))}
              {" · "}
              <span className="tabular-nums">{clock(att.durationMs)}</span>
            </p>
          </div>
          <div className="flex-1" />
          <Button
            type="button" variant="outline" size="icon-sm"
            aria-label={playing === "take" ? t("audio.inspector.pauseTake") : t("audio.inspector.playTake")}
            onClick={() => void play("take", () => loadTake(att))}
          >
            {loading === "take" ? <Spinner className="size-3" /> : playing === "take" ? <Pause /> : <Play />}
          </Button>
        </div>
        {text && <p dir="auto" className="line-clamp-3 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs">{text}</p>}
      </div>

      <section aria-label={t("audio.inspector.howMade")} className="space-y-1.5 border-b p-3">
        <SectionTitle>{t("audio.inspector.howMade")}</SectionTitle>
        <ol className="space-y-1 text-xs" data-testid="clip-inspector-story">
          {story.kind !== "spoken" && story.reader == null && (
            <StoryRow n={1}>{story.recordedBy ? t("audio.inspector.stepRecordedBy", { name: story.recordedBy }) : t("audio.inspector.stepRecorded")}</StoryRow>
          )}
          {story.reader && <StoryRow n={1}>{t("audio.inspector.stepSpoken", { name: story.reader.name })}</StoryRow>}
          {story.kind === "revoiced" && (
            <StoryRow n={2} strong>{t("audio.inspector.stepRevoiced", { name: story.character?.name ?? t("audio.inspector.removedVoice") })}</StoryRow>
          )}
        </ol>
      </section>

      <section aria-label={t("audio.inspector.delivery")} className="space-y-3 border-b p-3">
        <SectionTitle>{t("audio.inspector.delivery")}</SectionTitle>
        {!tunable ? (
          <p className="text-xs text-muted-foreground">{t("audio.inspector.deliveryNeedsElevenLabs", { name: speaker.name })}</p>
        ) : (
          <>
            <div role="group" aria-label={t("audio.inspector.scope")} className="grid grid-cols-2 overflow-hidden rounded-lg border text-xs">
              {(["line", "voice"] as const).map((value) => (
                <button
                  key={value} type="button" aria-pressed={scope === value} disabled={!canEdit}
                  className={cn("h-8 px-2 truncate", scope === value ? "bg-foreground text-background font-medium" : "hover:bg-accent")}
                  onClick={() => { void flush(); setDraft(null); setScope(value) }}
                >
                  {value === "line" ? t("audio.inspector.scopeLine") : t("audio.inspector.scopeVoice", { name: speaker.name })}
                </button>
              ))}
            </div>

            {KNOBS.map((knob) => (
              <div key={knob.key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium">{t(knob.labelKey)}</span>
                  <span className="tabular-nums text-muted-foreground">{formatKnob(knob.key, shown[knob.key])}</span>
                </div>
                <Slider
                  min={knob.min} max={knob.max} step={0.05} disabled={!canEdit}
                  value={[shown[knob.key]]}
                  onValueChange={(next) => {
                    const value = Array.isArray(next) ? next[0] : next
                    if (typeof value === "number") setDraft({ ...shown, [knob.key]: Math.round(value * 100) / 100 })
                  }}
                  aria-label={t(knob.labelKey)}
                />
              </div>
            ))}

            <div className="space-y-1.5">
              <p className="text-xs font-medium">{t("audio.inspector.tags")}</p>
              <div className="flex flex-wrap gap-1.5" data-testid="clip-inspector-tags">
                {[...new Set([...SUGGESTED_LINE_TAGS, ...tags])].map((tag) => (
                  <button
                    key={tag} type="button" aria-pressed={tags.includes(tag)} disabled={!canEdit}
                    className={cn(
                      "h-6 rounded-full border px-2 text-xs",
                      tags.includes(tag) ? "border-primary bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent",
                    )}
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
                {customTag == null ? (
                  <button
                    type="button" disabled={!canEdit}
                    className="h-6 rounded-full border border-dashed px-2 text-xs text-muted-foreground hover:bg-accent"
                    onClick={() => setCustomTag("")}
                  >
                    {t("audio.inspector.otherTag")}
                  </button>
                ) : (
                  <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); addCustomTag() }}>
                    <Input
                      autoFocus value={customTag} onChange={(e) => setCustomTag(e.target.value)}
                      onBlur={addCustomTag}
                      aria-label={t("audio.inspector.otherTagAriaLabel")}
                      placeholder={t("audio.inspector.otherTagPlaceholder")}
                      className="h-6 w-32 px-2 text-xs"
                    />
                  </form>
                )}
              </div>
              {readsTags ? (
                <p className="text-[11px] text-muted-foreground">{t("audio.inspector.tagsNote")}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {t("audio.inspector.tagsNeedModel", { model: modelName, name: speaker.name })}{" "}
                  <button type="button" disabled={!canEdit} className="underline underline-offset-2 hover:text-foreground" onClick={useTagModel}>
                    {t("audio.inspector.useTagModel")}
                  </button>
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                type="button" className="flex-1" disabled={busy || !text}
                onClick={() => { void flush().then(onRegenerate) }}
                data-testid="clip-inspector-regenerate"
              >
                {busy ? <Spinner className="size-3" /> : <RefreshCw data-icon="inline-start" />}
                {t("audio.inspector.regenerate")}
              </Button>
              <Button type="button" variant="outline" disabled={!text || !session} onClick={hearItFirst}>
                {loading === "preview" ? <Spinner className="size-3" /> : playing === "preview" ? <Pause /> : <Play />}
                {playing === "preview" ? t("audio.elevenLabs.stopPreview") : t("audio.inspector.hearItFirst")}
              </Button>
            </div>
          </>
        )}
        {!tunable && (
          <Button type="button" className="w-full" disabled={busy || !text} onClick={onRegenerate} data-testid="clip-inspector-regenerate">
            {busy ? <Spinner className="size-3" /> : <RefreshCw data-icon="inline-start" />}
            {t("audio.inspector.regenerate")}
          </Button>
        )}
        {error && <p className="select-text break-words text-xs text-destructive" role="alert">{error}</p>}
      </section>

      <section aria-label={t("audio.inspector.voice")} className="space-y-2 p-3">
        <SectionTitle>{t("audio.inspector.voice")}</SectionTitle>
        <p className="text-xs text-muted-foreground">{t("audio.inspector.lineVoice", { name: lineVoice.name })}</p>
        {otherVoices.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="clip-inspector-voices">
            {otherVoices.map((voice) => (
              <button
                key={voice.id} type="button" disabled={busy}
                className="flex h-7 items-center gap-1.5 rounded-full border ps-1 pe-2.5 text-xs hover:bg-accent disabled:opacity-50"
                aria-label={t("audio.inspector.useVoice", { name: voice.name })}
                onClick={() => onPickVoice(voice.id)}
              >
                <VoiceAvatar voice={voice} size={20} className="rounded-full" />
                <span className="max-w-28 truncate">{voice.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!canEdit} onClick={onAddVoice}>
            <Plus data-icon="inline-start" />
            {t("audio.inspector.addVoice")}
          </Button>
          {onTrainFromTake && (
            <Button type="button" variant="outline" size="sm" onClick={onTrainFromTake}>
              <Mic data-icon="inline-start" />
              {t("audio.inspector.newVoiceFromTake")}
            </Button>
          )}
        </div>
      </section>
    </div>
  )
}

function BackRow({ onBack, label }: { onBack: () => void; label: string }) {
  const t = useT()
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="icon-sm" aria-label={t("audio.inspector.backToVoices")} onClick={onBack}>
        <ArrowLeft />
      </Button>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
}

function StoryRow({ n, strong, children }: { n: number; strong?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
          strong ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {n}
      </span>
      <span>{children}</span>
    </li>
  )
}
