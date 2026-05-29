// The Voice Studio's left rail: the project's whole voice setup in one always-
// visible panel — TTS engine + Gemini key, the voice library, and an in-place
// editor for the selected voice (incl. voice-clone reference). This replaces
// the old VoiceModal (a per-cell dialog) and the Project-Settings "Voice
// engine" card: voice management now lives only in the Studio.
//
// Local-state mirror: the library is seeded once from `settings` and edited
// locally, writing through to the project async. Re-deriving from props each
// render would lag a tick behind patchProject→refresh and make the
// "find selected voice" lookup miss a just-added fork.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Check, Copy, KeyRound, Loader2, Mic, Pause, Play, Plus, Settings2, Sparkles, Star, Trash2, Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { GEMINI_TTS_MODEL, GEMINI_TTS_VOICES } from "@/lib/audio/gemini-tts"
import { forkVoice, newVoiceId, PRESET_VOICES, VOICE_PALETTE } from "@/lib/audio/voices"
import { synthesizeToWavBlob } from "@/lib/audio/tts"
import {
  DEFAULT_TTS_PROVIDER, TTS_PROVIDER_INFOS,
  defaultVoiceNameForProvider, normalizeVoiceForProvider,
} from "@/lib/audio/tts-providers"
import {
  HAS_EXTENDED_MMS_MODELS, HAS_HOSTED_MMS_MODELS, POPULAR_MMS_LANGUAGES,
  USE_SHERPA_MMS_MODELS, mmsModelIdForLanguage,
} from "@/lib/audio/mms-languages"
import { setUserApiKey, useUserApiKey } from "@/lib/store/user-api-keys"
import { ApiKeyField } from "@/components/ApiKeyField"
import { VoiceCloneSection } from "./VoiceCloneSection"
import type { FrontierSession } from "@/lib/frontier/types"

const SAMPLE_TEXT = "The quick brown fox jumps over the lazy dog."

export interface CastMemberStats {
  /** Lines assigned to this cast member in the current file. */
  assigned: number
  /** Of the assigned lines, how many already have generated audio. */
  voiced: number
}

interface Props {
  targetLanguage?: string
  settings: ProjectTtsSettings | undefined
  onSettingsChange: (next: Partial<ProjectTtsSettings>) => void | Promise<void>
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  /** The active cast member — its lines highlight in the list and it's the
   *  target of the "assign selected lines" action. */
  selectedVoiceId?: string
  onSelectVoice?: (voiceId: string) => void
  /** Per-member line counts for the current file (voiceId → stats). */
  castStats?: Map<string, CastMemberStats>
}

export function VoiceLibraryPanel({
  targetLanguage, settings, onSettingsChange, projectId, fileId, session,
  selectedVoiceId, onSelectVoice, castStats,
}: Props) {
  const provider = settings?.provider ?? DEFAULT_TTS_PROVIDER
  const userKey = useUserApiKey("gemini-tts")
  const apiKey = (settings?.apiKey?.trim() || userKey) ?? ""
  const needsKey = provider === "gemini" && !apiKey

  const [voices, setVoices] = useState<Voice[]>([])
  const [defaultVoiceId, setDefaultVoiceId] = useState<string | undefined>(undefined)
  const [localSelectedId, setLocalSelectedId] = useState<string>("")
  const seededRef = useRef<string | null>(null)
  const [engineOpen, setEngineOpen] = useState(false)
  // Bumped when the user creates a clone profile, so the editor scrolls its
  // reference recorder into view and pulses it.
  const [cloneFocusSignal, setCloneFocusSignal] = useState(0)

  // Seed the local library once per project. The studio mounts this only after
  // the project has loaded, so settings is available on first render.
  useEffect(() => {
    if (!projectId || seededRef.current === projectId) return
    const seed = settings?.voices && settings.voices.length > 0 ? settings.voices : [...PRESET_VOICES]
    const seedDefault = settings?.defaultVoiceId ?? seed[0]?.id
    setVoices(seed)
    setDefaultVoiceId(seedDefault)
    setLocalSelectedId(seedDefault ?? seed[0]?.id ?? "")
    seededRef.current = projectId
  }, [projectId, settings])

  const selectedId = selectedVoiceId ?? localSelectedId
  const selected = voices.find((v) => v.id === selectedId) ?? voices[0]

  const select = useCallback((id: string) => {
    setLocalSelectedId(id)
    onSelectVoice?.(id)
  }, [onSelectVoice])

  const writeBack = useCallback((nextVoices: Voice[], nextDefault: string | undefined) => {
    setVoices(nextVoices)
    setDefaultVoiceId(nextDefault)
    void onSettingsChange({ voices: nextVoices, defaultVoiceId: nextDefault })
  }, [onSettingsChange])

  const update = useCallback((patch: Partial<Voice>) => {
    setVoices((cur) => {
      const target = cur.find((v) => v.id === selectedId)
      if (!target) return cur
      const next = cur.map((v) => v.id === selectedId ? { ...v, ...patch } : v)
      void onSettingsChange({ voices: next, defaultVoiceId })
      return next
    })
  }, [selectedId, defaultVoiceId, onSettingsChange])

  const duplicateSelected = useCallback(() => {
    if (!selected) return
    const copy = forkVoice(selected)
    select(copy.id)
    writeBack([...voices, copy], defaultVoiceId)
  }, [selected, voices, writeBack, defaultVoiceId, select])

  const addBlank = useCallback(() => {
    const copy: Voice = {
      id: newVoiceId(),
      name: "New character",
      color: VOICE_PALETTE[voices.length % VOICE_PALETTE.length],
      provider,
      voiceName: defaultVoiceNameForProvider(provider, { targetLanguage }),
      builtIn: false,
    }
    select(copy.id)
    writeBack([...voices, copy], defaultVoiceId)
  }, [voices, provider, targetLanguage, writeBack, defaultVoiceId, select])

  // Create a fresh voice and jump straight to its reference recorder — a clone
  // profile is a normal voice whose TTS output is re-voiced into a recorded
  // timbre, so the only extra step is capturing that reference.
  const addClone = useCallback(() => {
    const copy: Voice = {
      id: newVoiceId(),
      name: "New character",
      color: VOICE_PALETTE[voices.length % VOICE_PALETTE.length],
      provider,
      voiceName: defaultVoiceNameForProvider(provider, { targetLanguage }),
      builtIn: false,
    }
    select(copy.id)
    writeBack([...voices, copy], defaultVoiceId)
    setCloneFocusSignal((n) => n + 1)
  }, [voices, provider, targetLanguage, writeBack, defaultVoiceId, select])

  const deleteSelected = useCallback(() => {
    if (!selected) return
    const next = voices.filter((v) => v.id !== selected.id)
    const nextDefault = defaultVoiceId === selected.id ? next[0]?.id : defaultVoiceId
    select(next[0]?.id ?? "")
    writeBack(next, nextDefault)
  }, [selected, voices, writeBack, defaultVoiceId, select])

  const setDefault = useCallback(() => {
    if (!selected) return
    writeBack(voices, selected.id)
  }, [selected, voices, writeBack])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Users className="h-4 w-4 text-primary" /> Cast
        </h2>
        <span className="text-xs text-muted-foreground">
          {voices.length} {voices.length === 1 ? "character" : "characters"}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* Engine — collapsible so the key + provider don't crowd the library. */}
        <div className="overflow-hidden rounded-xl border bg-muted/20">
          <button
            type="button"
            onClick={() => setEngineOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium"
          >
            <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
            Engine
            <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {provider}
            </span>
            {needsKey && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                <KeyRound className="h-2.5 w-2.5" /> Key needed
              </span>
            )}
          </button>
          {(engineOpen || needsKey) && (
            <div className="space-y-3 border-t px-3 py-3">
              <div className="grid grid-cols-3 gap-1.5">
                {TTS_PROVIDER_INFOS.map((info) => (
                  <button
                    key={info.id}
                    type="button"
                    onClick={() => void onSettingsChange({ provider: info.id })}
                    aria-pressed={provider === info.id}
                    title={info.hint}
                    className={cn(
                      "rounded-lg border px-2 py-1.5 text-center text-xs transition-colors",
                      provider === info.id ? "border-primary bg-primary/10 font-medium" : "hover:bg-accent/40",
                    )}
                  >
                    {info.shortTitle ?? info.title}
                  </button>
                ))}
              </div>
              {provider === "gemini" ? (
                <ApiKeyField
                  label="Gemini API key"
                  placeholder="AIza..."
                  projectKey={settings?.apiKey ?? ""}
                  userKey={userKey ?? ""}
                  onProjectKeyChange={(v) => void onSettingsChange({ apiKey: v || undefined })}
                  onUserKeyChange={(v) => setUserApiKey("gemini-tts", v)}
                  help={needsKey
                    ? "Get a key at aistudio.google.com/apikey. Sent directly to Google; never uploaded to Frontier."
                    : "Sent directly to Google. Never uploaded to Frontier."}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {provider === "mms"
                    ? "No API key. Each MMS voice is tied to one language code."
                    : "No API key needed. Runs locally in your browser."}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Cast roster — one card per character. Click selects (highlights its
            lines + becomes the assign target); drag onto a line assigns. */}
        <div className="space-y-1">
          {voices.map((voice) => {
            const active = voice.id === selected?.id
            const stats = castStats?.get(voice.id)
            const isNarrator = voice.id === defaultVoiceId
            return (
              <button
                key={voice.id}
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(VOICE_ASSIGN_MIME, voice.id)
                  e.dataTransfer.effectAllowed = "copy"
                }}
                onClick={() => select(voice.id)}
                title="Click to select · drag onto a line to assign"
                className={cn(
                  "group flex w-full cursor-grab items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors active:cursor-grabbing",
                  active ? "border-primary/50 bg-primary/10"
                    : voice.referenceAudioId ? "border-violet-300/50 bg-violet-50/40 hover:bg-violet-100/50 dark:border-violet-500/20 dark:bg-violet-950/20"
                    : "border-transparent bg-muted/30 hover:bg-accent/40",
                )}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full border"
                  style={{ backgroundColor: voice.color || "#94a3b8" }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="truncate">{voice.name}</span>
                    {isNarrator && <Star className="h-3 w-3 shrink-0 text-primary" aria-label="Narrator (default)" />}
                  </span>
                  <span className="block text-[10px] leading-tight text-muted-foreground">
                    {voice.referenceAudioId ? "character voice · " : ""}
                    {stats && stats.assigned > 0
                      ? `${stats.voiced}/${stats.assigned} lines voiced`
                      : isNarrator ? "unassigned lines" : "no lines yet"}
                  </span>
                </span>
                {voice.referenceAudioId && (
                  <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-violet-600 dark:text-violet-300">
                    <Sparkles className="h-2.5 w-2.5" /> Character
                  </span>
                )}
              </button>
            )
          })}
          <div className="flex gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={addBlank} className="flex-1 justify-start">
              <Plus className="mr-1 h-3.5 w-3.5" /> Add character
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={addClone} className="flex-1 justify-start text-violet-600 hover:text-violet-700 dark:text-violet-300" title="Create a character voice from a fresh recording">
              <Mic className="mr-1 h-3.5 w-3.5" /> Record a character
            </Button>
          </div>
        </div>

        {/* Editor — selected voice */}
        {selected && (
          <div className="rounded-xl border bg-background p-3">
            <VoiceEditor
              voice={selected}
              provider={provider}
              apiKey={apiKey}
              targetLanguage={targetLanguage}
              isDefault={selected.id === defaultVoiceId}
              onChange={update}
              onDuplicate={duplicateSelected}
              onDelete={deleteSelected}
              onSetDefault={setDefault}
              projectId={projectId}
              fileId={fileId}
              session={session}
              cloneFocusSignal={cloneFocusSignal}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** DnD mime carrying a voice id dragged from a library card onto a production
 *  row (assigns the voice for that row's generation). */
export const VOICE_ASSIGN_MIME = "application/x-frontier-voice-assign"

// ── Editor ────────────────────────────────────────────────────────────────

interface VoiceEditorProps {
  voice: Voice
  provider: NonNullable<ProjectTtsSettings["provider"]>
  apiKey: string
  targetLanguage?: string
  isDefault: boolean
  onChange: (patch: Partial<Voice>) => void
  onDuplicate: () => void
  onDelete: () => void
  onSetDefault: () => void
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  /** Bumped to scroll the clone recorder into view (after "Clone voice"). */
  cloneFocusSignal?: number
}

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "playing" }
  | { kind: "error"; message: string }

function VoiceEditor({
  voice, provider, apiKey, targetLanguage, isDefault,
  onChange, onDuplicate, onDelete, onSetDefault,
  projectId, fileId, session, cloneFocusSignal,
}: VoiceEditorProps) {
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" })
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  const effectiveVoice = normalizeVoiceForProvider(voice, provider, { targetLanguage })

  const stopPreview = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setPreview({ kind: "idle" })
  }, [])

  useEffect(() => stopPreview, [stopPreview])
  useEffect(() => { stopPreview() }, [voice.id, stopPreview])

  const handleTest = useCallback(async () => {
    if (preview.kind === "playing") { stopPreview(); return }
    if (provider === "gemini" && !apiKey.trim()) {
      setPreview({ kind: "error", message: "Add a Gemini API key above to test voices." })
      return
    }
    setPreview({ kind: "loading" })
    try {
      const blob = await synthesizeToWavBlob(SAMPLE_TEXT, {
        voice: effectiveVoice,
        projectProvider: provider,
        apiKey,
        geminiContext: { targetLanguage },
      })
      const url = URL.createObjectURL(blob)
      previewUrlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = stopPreview
      audio.onpause = () => {
        if (audioRef.current === audio) setPreview((p) => p.kind === "playing" ? { kind: "idle" } : p)
      }
      setPreview({ kind: "playing" })
      await audio.play()
    } catch (e) {
      setPreview({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }, [effectiveVoice, provider, apiKey, targetLanguage, preview.kind, stopPreview])

  const isGemini = provider === "gemini"
  const isMms = provider === "mms"

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-center gap-2">
        <ColorDot color={voice.color} onPick={(c) => onChange({ color: c })} />
        <Input
          value={voice.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="h-9 min-w-0 flex-1 font-medium"
          aria-label="Voice name"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleTest}
          disabled={preview.kind === "loading"}
          className="shrink-0"
          aria-label={preview.kind === "playing" ? "Stop preview" : "Test voice"}
        >
          {preview.kind === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : preview.kind === "playing" ? <Pause className="h-3.5 w-3.5" />
            : <Play className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {preview.kind === "error" && (
        <p className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {preview.message}
        </p>
      )}

      {isMms ? (
        <MmsLanguagePicker
          value={effectiveVoice.voiceName ?? ""}
          onChange={(v) => onChange({ voiceName: v || undefined })}
        />
      ) : isGemini ? (
        <>
          <div>
            <Label htmlFor="voice-engine">Gemini voice</Label>
            <select
              id="voice-engine"
              value={effectiveVoice.voiceName ?? ""}
              onChange={(e) => onChange({ voiceName: e.target.value || undefined })}
              className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
            >
              {GEMINI_TTS_VOICES.map((v) => (
                <option key={v.name} value={v.name}>{v.name} — {v.description}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <Label htmlFor="voice-accent">Accent</Label>
              <Input
                id="voice-accent"
                value={voice.accent ?? ""}
                onChange={(e) => onChange({ accent: e.target.value || undefined })}
                placeholder="e.g. coastal Swahili reading"
                className="mt-1"
              />
            </div>
            <div className="min-w-0">
              <Label htmlFor="voice-pron">Pronunciation reference</Label>
              <Input
                id="voice-pron"
                value={voice.pronunciationReference ?? ""}
                onChange={(e) => onChange({ pronunciationReference: e.target.value || undefined })}
                placeholder="e.g. Swahili"
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="voice-prompt">Prompt</Label>
            <textarea
              id="voice-prompt"
              value={voice.prompt ?? ""}
              onChange={(e) => onChange({ prompt: e.target.value || undefined })}
              rows={5}
              className="neu-inset mt-1 w-full rounded px-3 py-2 font-mono text-sm"
              placeholder="Read this {target} text in a calm, clear voice…"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Placeholders: <Code>{"{text}"}</Code> <Code>{"{target}"}</Code>{" "}
              <Code>{"{accent}"}</Code> <Code>{"{original}"}</Code> <Code>{"{context}"}</Code>
            </p>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Advanced — model override</summary>
            <Input
              value={voice.model ?? ""}
              onChange={(e) => onChange({ model: e.target.value || undefined })}
              placeholder={GEMINI_TTS_MODEL}
              className="mt-1 font-mono"
              aria-label="Gemini model"
            />
          </details>
        </>
      ) : (
        <div>
          <Label htmlFor="voice-engine">Kokoro voice id</Label>
          <Input
            id="voice-engine"
            value={effectiveVoice.voiceName ?? ""}
            onChange={(e) => onChange({ voiceName: e.target.value || undefined })}
            placeholder="e.g. af_bella"
            className="mt-1 font-mono"
          />
        </div>
      )}

      <VoiceCloneSection
        voice={voice}
        projectId={projectId}
        fileId={fileId}
        session={session}
        onChange={onChange}
        focusSignal={cloneFocusSignal}
      />

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {!isDefault && (
          <Button type="button" size="sm" variant="outline" onClick={onSetDefault}>
            <Check className="mr-1 h-3.5 w-3.5" /> Make default
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={onDuplicate}>
          <Copy className="mr-1 h-3.5 w-3.5" /> Duplicate
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
        </Button>
      </div>
    </div>
  )
}

function ColorDot({ color, onPick }: { color?: string; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Voice color"
        className="h-7 w-7 rounded-full border"
        style={{ backgroundColor: color || "#94a3b8" }}
      />
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 grid grid-cols-6 gap-1 rounded-md border bg-popover p-1.5 shadow-md">
          {VOICE_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { onPick(c); setOpen(false) }}
              className="h-5 w-5 rounded-full border"
              style={{ backgroundColor: c }}
              aria-label={`Pick color ${c}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1">{children}</code>
}

interface MmsLanguagePickerProps {
  value: string
  onChange: (next: string) => void
}

function MmsLanguagePicker({ value, onChange }: MmsLanguagePickerProps) {
  const knownCode = POPULAR_MMS_LANGUAGES.some((l) => l.code === value)
  const selectValue = knownCode ? value : HAS_EXTENDED_MMS_MODELS ? "__other__" : ""
  const modelId = mmsModelIdForLanguage(value) ?? mmsModelIdForLanguage("eng") ?? "Xenova/mms-tts-eng"
  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="mms-lang">Language</Label>
        <select
          id="mms-lang"
          value={selectValue}
          onChange={(e) => {
            const next = e.target.value
            onChange(next === "__other__" ? "" : next)
          }}
          className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
        >
          {!knownCode && !HAS_EXTENDED_MMS_MODELS && (
            <option value="" disabled>
              {value ? `Unsupported code: ${value}` : "Choose a language"}
            </option>
          )}
          {POPULAR_MMS_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
          ))}
          {HAS_EXTENDED_MMS_MODELS && <option value="__other__">Other MMS code</option>}
        </select>
      </div>
      {HAS_EXTENDED_MMS_MODELS && (
        <div>
          <Label htmlFor="mms-code">MMS code</Label>
          <Input
            id="mms-code"
            value={value}
            onChange={(e) => onChange(e.target.value.trim().toLowerCase())}
            placeholder="ita"
            className="mt-1 font-mono"
          />
        </div>
      )}
      {!HAS_EXTENDED_MMS_MODELS && !knownCode && value && (
        <p className="text-xs text-destructive">
          This MMS code is not available in the public browser model set.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Loads <Code>{modelId}</Code> on first use (~130 MB per language, cached after).
        {USE_SHERPA_MMS_MODELS ? " Sherpa-ONNX MMS codes are allowed."
          : HAS_HOSTED_MMS_MODELS ? " Hosted R2 MMS codes are allowed."
          : " Only browser-ready Xenova MMS-TTS repos are listed here."}
      </p>
    </div>
  )
}
