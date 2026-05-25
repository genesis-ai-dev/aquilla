// Per-cell Voice modal: full library + editor for the project's voices.
// Opened from a cell's voice button. Manages the project's voice library
// in-place; built-in voices auto-fork on edit. The user picks "Use for this
// cell" to apply a voice id to the cell.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Check, Copy, KeyRound, Loader2, Pause, Play, Plus, Sparkles, Star, Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import {
  DEFAULT_TTS_PROVIDER, GEMINI_TTS_MODEL, GEMINI_TTS_VOICES,
} from "@/lib/audio/gemini-tts"
import {
  forkVoice, newVoiceId, PRESET_VOICES, VOICE_PALETTE,
} from "@/lib/audio/voices"
import { synthesizeToWavBlob } from "@/lib/audio/tts"
import {
  HAS_EXTENDED_MMS_MODELS,
  HAS_HOSTED_MMS_MODELS,
  POPULAR_MMS_LANGUAGES,
  USE_SHERPA_MMS_MODELS,
  mmsModelIdForLanguage,
} from "@/lib/audio/mms-languages"
import { setUserApiKey, useUserApiKey } from "@/lib/store/user-api-keys"
import { defaultVoiceNameForProvider, normalizeVoiceForProvider } from "@/lib/audio/tts-providers"
import { ApiKeyField } from "@/components/ApiKeyField"
import type { FrontierSession } from "@/lib/frontier/types"
import { VoiceCloneSection } from "./VoiceCloneSection"

const SAMPLE_TEXT = "The quick brown fox jumps over the lazy dog."

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Project target language for the test-prompt context. */
  targetLanguage?: string
  settings: ProjectTtsSettings | undefined
  /** Persist a partial change to project tts settings. */
  onSettingsChange: (next: Partial<ProjectTtsSettings>) => void | Promise<void>
  /** When set, surface the matching recovery affordance prominently — e.g.
   *  "apiKey" pins an inline ApiKeyField at the top of the dialog. Used by
   *  the disabled voice chip flow so the user lands directly on the fix. */
  initialFocus?: "apiKey"
  /** Project context for voice-clone reference uploads. When absent the clone
   *  section renders a "context unavailable" hint instead of the record UI. */
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
}

export function VoiceModal({
  open, onOpenChange, targetLanguage, settings, onSettingsChange, initialFocus,
  projectId, fileId, session,
}: Props) {
  const provider = settings?.provider ?? DEFAULT_TTS_PROVIDER
  // Resolve the API key with project → user-saved fallback so the Test
  // button works even when the user only set their key in another project.
  const userKey = useUserApiKey("gemini-tts")
  const apiKey = (settings?.apiKey?.trim() || userKey) ?? ""
  const showKeyBanner = provider === "gemini" && (initialFocus === "apiKey" || !apiKey)

  // Local mirror of the library + selection. Seeded from props on each
  // open transition; subsequent edits stay local and write through async.
  // Reading the library from local state (instead of re-deriving from
  // `settings` props every render) is critical: patchProject → refresh is
  // async, so a derived library would lag a tick behind each keystroke and
  // the "find selected voice" lookup would miss the just-added fork —
  // which is exactly how the editor used to spawn a fresh fork per character.
  const [voices, setVoices] = useState<Voice[]>([])
  const [defaultVoiceId, setDefaultVoiceId] = useState<string | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string>("")
  const prevOpenRef = useRef(false)

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      const seed = settings?.voices && settings.voices.length > 0 ? settings.voices : [...PRESET_VOICES]
      const seedDefault = settings?.defaultVoiceId ?? seed[0]?.id
      setVoices(seed)
      setDefaultVoiceId(seedDefault)
      setSelectedId(seedDefault ?? seed[0]?.id ?? "")
    }
    prevOpenRef.current = open
  }, [open, settings])

  const selected = voices.find((v) => v.id === selectedId) ?? voices[0]

  /** Persist a library replacement locally + through to project settings. */
  const writeBack = useCallback((nextVoices: Voice[], nextDefault: string | undefined) => {
    setVoices(nextVoices)
    setDefaultVoiceId(nextDefault)
    void onSettingsChange({ voices: nextVoices, defaultVoiceId: nextDefault })
  }, [onSettingsChange])

  /** Edit the selected voice in place. Presets are editable too — once a
   *  user edits one the project owns its modified version, but the voice's
   *  id is preserved (so cells pointing at it still resolve correctly). */
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
    const next = [...voices, copy]
    setSelectedId(copy.id)
    writeBack(next, defaultVoiceId)
  }, [selected, voices, writeBack, defaultVoiceId])

  const addBlank = useCallback(() => {
    const copy: Voice = {
      id: newVoiceId(),
      name: "New voice",
      color: VOICE_PALETTE[voices.length % VOICE_PALETTE.length],
      provider,
      voiceName: defaultVoiceNameForProvider(provider, { targetLanguage }),
      builtIn: false,
    }
    const next = [...voices, copy]
    setSelectedId(copy.id)
    writeBack(next, defaultVoiceId)
  }, [voices, provider, targetLanguage, writeBack, defaultVoiceId])

  const deleteSelected = useCallback(() => {
    if (!selected) return
    const next = voices.filter((v) => v.id !== selected.id)
    const nextDefault = defaultVoiceId === selected.id ? next[0]?.id : defaultVoiceId
    setSelectedId(next[0]?.id ?? "")
    writeBack(next, nextDefault)
  }, [selected, voices, writeBack, defaultVoiceId])

  const setDefault = useCallback(() => {
    if (!selected) return
    writeBack(voices, selected.id)
  }, [selected, voices, writeBack])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(960px,calc(100vw-2rem))] sm:max-w-none">
        <DialogHeader>
          <DialogTitle>Voices</DialogTitle>
          <DialogDescription>
            Each voice bundles voice id, accent, pronunciation, and prompt. Drag voices onto cells to generate.
          </DialogDescription>
        </DialogHeader>

        {showKeyBanner && (
          <div
            className={cn(
              "rounded-md border p-3",
              !apiKey
                ? "border-amber-300/60 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-950/30"
                : "bg-muted/30",
            )}
          >
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-3.5 w-3.5" />
              {!apiKey
                ? "Add your Gemini API key to use Gemini voices"
                : "Gemini API key"}
            </div>
            <ApiKeyField
              label=""
              placeholder="AIza..."
              projectKey={settings?.apiKey ?? ""}
              userKey={userKey ?? ""}
              onProjectKeyChange={(v) => void onSettingsChange({ apiKey: v || undefined })}
              onUserKeyChange={(v) => setUserApiKey("gemini-tts", v)}
              help={!apiKey
                ? "Get a key at aistudio.google.com/apikey. Sent directly to Google; never uploaded to Frontier."
                : "Sent directly to Google. Never uploaded to Frontier."}
            />
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
          <VoiceList
            library={voices}
            selectedId={selected?.id ?? ""}
            defaultVoiceId={defaultVoiceId}
            onSelect={setSelectedId}
            onAdd={addBlank}
          />
          {selected ? (
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
            />
          ) : (
            <div className="text-sm text-muted-foreground">No voice selected.</div>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Drag voices onto cells from the toolbar to generate.
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Subcomponents ───────────────────────────────────────────────────────────

interface VoiceListProps {
  library: Voice[]
  selectedId: string
  defaultVoiceId: string | undefined
  onSelect: (id: string) => void
  onAdd: () => void
}

function VoiceList({ library, selectedId, defaultVoiceId, onSelect, onAdd }: VoiceListProps) {
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/20 p-1">
      <div className="max-h-[420px] space-y-0.5 overflow-y-auto">
        {library.map((voice) => {
          const active = voice.id === selectedId
          return (
            <button
              key={voice.id}
              type="button"
              onClick={() => onSelect(voice.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
                active ? "bg-primary/10 text-foreground" : "hover:bg-accent/40",
              )}
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full border"
                style={{ backgroundColor: voice.color || "#94a3b8" }}
              />
              <span className="flex-1 truncate">{voice.name}</span>
              {voice.referenceAudioId && (
                <Sparkles className="h-3 w-3 text-violet-500" aria-label="Voice clone" />
              )}
              {voice.id === defaultVoiceId && (
                <Star className="h-3 w-3 text-primary" aria-label="Default" />
              )}
            </button>
          )
        })}
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={onAdd} className="mt-1 justify-start">
        <Plus className="mr-1 h-3.5 w-3.5" /> New voice
      </Button>
    </div>
  )
}

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
}

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "playing" }
  | { kind: "error"; message: string }

function VoiceEditor({
  voice, provider, apiKey, targetLanguage, isDefault,
  onChange, onDuplicate, onDelete, onSetDefault,
  projectId, fileId, session,
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
    if (preview.kind === "playing") {
      stopPreview()
      return
    }
    if (provider === "gemini" && !apiKey.trim()) {
      setPreview({ kind: "error", message: "Add a Gemini API key in Project Settings to test voices." })
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
        {isDefault && (
          <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
            <Star className="h-2.5 w-2.5" /> Default
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleTest}
          disabled={preview.kind === "loading"}
          className="shrink-0"
          aria-label={preview.kind === "playing" ? "Stop preview" : "Test voice"}
        >
          {preview.kind === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : preview.kind === "playing" ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          <span className="ml-1">Test</span>
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
          <div className="grid gap-3 md:grid-cols-2">
            <div className="min-w-0">
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
            <div className="min-w-0">
              <Label htmlFor="voice-model">Model</Label>
              <Input
                id="voice-model"
                value={voice.model ?? ""}
                onChange={(e) => onChange({ model: e.target.value || undefined })}
                placeholder={GEMINI_TTS_MODEL}
                className="mt-1 font-mono"
              />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
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
              rows={6}
              className="w-full rounded border bg-background px-3 py-2 font-mono text-sm"
              placeholder="Read this {target} text in a calm, clear voice…"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Placeholders: <Code>{"{text}"}</Code> <Code>{"{target}"}</Code>{" "}
              <Code>{"{accent}"}</Code> <Code>{"{pronunciationReference}"}</Code>{" "}
              <Code>{"{original}"}</Code> <Code>{"{context}"}</Code> <Code>{"{cellLabel}"}</Code>
            </p>
          </div>
        </>
      ) : (
        <div>
          <Label htmlFor="voice-engine">Kokoro voice id</Label>
          <Input
            id="voice-engine"
            value={effectiveVoice.voiceName ?? ""}
            onChange={(e) => onChange({ voiceName: e.target.value || undefined })}
            placeholder="e.g. af_bella"
            className="font-mono"
          />
        </div>
      )}

      <VoiceCloneSection
        voice={voice}
        projectId={projectId}
        fileId={fileId}
        session={session}
        onChange={onChange}
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
      <div className="grid gap-3 md:grid-cols-[1fr_11rem]">
        <div className="min-w-0">
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
            {HAS_EXTENDED_MMS_MODELS && (
              <option value="__other__">Other MMS code</option>
            )}
          </select>
        </div>
        {HAS_EXTENDED_MMS_MODELS && (
          <div className="min-w-0">
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
      </div>
      {!HAS_EXTENDED_MMS_MODELS && !knownCode && value && (
        <p className="text-xs text-destructive">
          This MMS code is not available in the public browser model set.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Loads <Code>{modelId}</Code> on first use (~130 MB per language, cached after).
        {USE_SHERPA_MMS_MODELS ? (
          " Sherpa-ONNX MMS codes are allowed."
        ) : HAS_HOSTED_MMS_MODELS ? (
          " Hosted R2 MMS codes are allowed."
        ) : (
          " Only browser-ready Xenova MMS-TTS repos are listed here."
        )}
      </p>
    </div>
  )
}
