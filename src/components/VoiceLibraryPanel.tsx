// The Voice Studio's left rail: a calm CAST ROSTER. The shared Gemini key sits
// in a small collapsible bit at the top; below it is one flat list of voices
// (color dot, name, the engine it uses, line count, default star, a "Cloned"
// badge when it has a reference) plus "+ New voice".
//
// EVERY voice is the same primitive: a TTS engine + that engine's base voice,
// optionally with a reference recording layered on top to "clone a timbre". The
// engine is now PER-VOICE (chosen in the modal), so there's no project-level
// engine picker here — only the shared Gemini API key. A voice with a reference
// is what we used to call a "clone"; the only visual distinction is a small
// violet "Cloned" badge — not a separate section.
//
// Crafting a voice is a focused act — clicking a voice (or "+ New voice") opens
// the CharacterModal (the "voice creator"), not an always-open inline inspector.

import { useCallback, useEffect, useRef, useState } from "react"
import { KeyRound, Plus, Sparkles, Star, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ProjectTtsSettings, TtsProvider, Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { PRESET_VOICES } from "@/lib/audio/voices"
import { DEFAULT_TTS_PROVIDER, TTS_PROVIDER_INFOS } from "@/lib/audio/tts-providers"
import { useAnyGeminiKeyError } from "@/lib/audio/tts"
import { setUserApiKey, useUserApiKey } from "@/lib/store/user-api-keys"
import { ApiKeyField } from "@/components/ApiKeyField"
import { CharacterModal } from "@/components/voice/CharacterModal"
import type { FrontierSession } from "@/lib/frontier/types"

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
  /** All cells, so the modal's "use a take from a line" can list real takes. */
  cells?: CellData[]
  /** When the per-cell "+" fires, this names the cell whose take seeds a new
   *  character; `seedSignal` bumps so the same cell can re-open the creator. */
  seedCellId?: string | null
  seedSignal?: number
}

/** A voice being edited in the modal: an existing voice, or null = new. */
type Editing =
  | { kind: "closed" }
  | { kind: "edit"; voice: Voice }
  | { kind: "new"; seedCellId: string | null }

/** Friendly label for the engine a voice uses (defaults to Gemini). */
function engineLabel(provider: TtsProvider | undefined): string {
  const id = provider ?? DEFAULT_TTS_PROVIDER
  const info = TTS_PROVIDER_INFOS.find((p) => p.id === id)
  return info?.shortTitle ?? info?.title ?? id
}

export function VoiceLibraryPanel({
  targetLanguage, settings, onSettingsChange, projectId, fileId, session,
  selectedVoiceId, onSelectVoice, castStats, cells, seedCellId, seedSignal,
}: Props) {
  const provider = settings?.provider ?? DEFAULT_TTS_PROVIDER
  const userKey = useUserApiKey("gemini-tts")
  const apiKey = (settings?.apiKey?.trim() || userKey) ?? ""

  const [voices, setVoices] = useState<Voice[]>([])
  const [defaultVoiceId, setDefaultVoiceId] = useState<string | undefined>(undefined)
  const [localSelectedId, setLocalSelectedId] = useState<string>("")
  const seededRef = useRef<string | null>(null)
  const [keyOpen, setKeyOpen] = useState(false)
  const [editing, setEditing] = useState<Editing>({ kind: "closed" })

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

  // Engine is per-voice now; a key is "needed" when any voice runs on Gemini
  // (the default when provider is absent) and no shared key is set yet.
  const anyGeminiVoice = voices.some((v) => (v.provider ?? DEFAULT_TTS_PROVIDER) === "gemini")
  const needsKey = anyGeminiVoice && !apiKey
  // A6: distinguish "no key at all" from "key entered but invalid/rejected".
  // When a key IS present but synthesis has failed due to a key error, show
  // "Key invalid" so the user knows the key value was tried and rejected.
  const hasKeyError = useAnyGeminiKeyError()
  const keyBadgeLabel = needsKey
    ? "Key needed"
    : (anyGeminiVoice && apiKey && hasKeyError)
      ? "Key invalid"
      : null

  const select = useCallback((id: string) => {
    setLocalSelectedId(id)
    onSelectVoice?.(id)
  }, [onSelectVoice])

  const writeBack = useCallback((nextVoices: Voice[], nextDefault: string | undefined) => {
    setVoices(nextVoices)
    setDefaultVoiceId(nextDefault)
    void onSettingsChange({ voices: nextVoices, defaultVoiceId: nextDefault })
  }, [onSettingsChange])

  // Append-or-replace the saved character into the library.
  // NOTE: compute outside the setVoices updater — calling setDefaultVoiceId or
  // onSettingsChange (a parent setState) inside a functional updater triggers
  // React's "setState during render" warning (BUG-6 fix).
  const saveVoice = useCallback((voice: Voice) => {
    const exists = voices.some((v) => v.id === voice.id)
    const next = exists ? voices.map((v) => (v.id === voice.id ? voice : v)) : [...voices, voice]
    const nextDefault = defaultVoiceId ?? next[0]?.id
    setVoices(next)
    setDefaultVoiceId(nextDefault)
    void onSettingsChange({ voices: next, defaultVoiceId: nextDefault })
    select(voice.id)
  }, [voices, defaultVoiceId, onSettingsChange, select])

  const deleteVoice = useCallback((voice: Voice) => {
    const next = voices.filter((v) => v.id !== voice.id)
    const nextDefault = defaultVoiceId === voice.id ? next[0]?.id : defaultVoiceId
    select(next[0]?.id ?? "")
    writeBack(next, nextDefault)
  }, [voices, defaultVoiceId, writeBack, select])

  const makeDefault = useCallback((voice: Voice) => {
    writeBack(voices, voice.id)
  }, [voices, writeBack])

  const openNew = useCallback((seed: string | null) => {
    setEditing({ kind: "new", seedCellId: seed })
  }, [])

  const openEdit = useCallback((voice: Voice) => {
    select(voice.id)
    setEditing({ kind: "edit", voice })
  }, [select])

  // The per-cell "+" opens the creator seeded to that take. `seedSignal` bumps
  // each time so picking the same cell twice still re-opens the modal.
  useEffect(() => {
    if (!seedSignal) return
    setEditing({ kind: "new", seedCellId: seedCellId ?? null })
  }, [seedSignal, seedCellId])

  const modalVoice = editing.kind === "edit" ? editing.voice : null
  const modalSeed = editing.kind === "new" ? editing.seedCellId : null

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
        {/* Gemini API key — a shared credential across all Gemini voices (engine
            is now per-voice, set in the voice creator). Kept here as a small
            collapsible since Gemini is the default engine. */}
        <div className="overflow-hidden rounded-xl border bg-muted/20">
          <button
            type="button"
            onClick={() => setKeyOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium"
          >
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            Gemini API key
            {keyBadgeLabel && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                <KeyRound className="h-2.5 w-2.5" /> {keyBadgeLabel}
              </span>
            )}
          </button>
          {(keyOpen || needsKey || (anyGeminiVoice && apiKey && hasKeyError)) && (
            <div className="space-y-3 border-t px-3 py-3">
              <ApiKeyField
                label="Gemini API key"
                placeholder="AIza..."
                projectKey={settings?.apiKey ?? ""}
                userKey={userKey ?? ""}
                onProjectKeyChange={(v) => void onSettingsChange({ apiKey: v || undefined })}
                onUserKeyChange={(v) => setUserApiKey("gemini-tts", v)}
                help={needsKey
                  ? "Get a key at aistudio.google.com/apikey. Sent directly to Google; never uploaded to Frontier."
                  : hasKeyError
                    ? "This key was rejected by Google. Check it's correct at aistudio.google.com/apikey."
                    : "Sent directly to Google. Never uploaded to Frontier."}
              />
            </div>
          )}
        </div>

        {/* Cast roster — one flat list. Every voice is the same primitive (an
            engine + base voice, optionally with a clone reference); a clone is
            marked only by a small violet badge. Click opens the creator; drag
            onto a line assigns. */}
        <div className="space-y-1">
          {voices.map((voice) => {
            const active = voice.id === selectedId
            const stats = castStats?.get(voice.id)
            const isNarrator = voice.id === defaultVoiceId
            const isClone = Boolean(voice.referenceAudioId)
            return (
              <button
                key={voice.id}
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(VOICE_ASSIGN_MIME, voice.id)
                  e.dataTransfer.effectAllowed = "copy"
                }}
                onClick={() => openEdit(voice)}
                title="Click to craft · drag onto a line to assign"
                className={cn(
                  "group flex w-full cursor-grab items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors active:cursor-grabbing",
                  active ? "border-primary/50 bg-primary/10"
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
                    {isClone && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground dark:bg-muted dark:text-muted-foreground">
                        <Sparkles className="h-2 w-2" /> Cloned
                      </span>
                    )}
                  </span>
                  <span className="block text-[10px] leading-tight text-muted-foreground">
                    {engineLabel(voice.provider)}
                    {" · "}
                    {stats && stats.assigned > 0
                      ? `${stats.voiced}/${stats.assigned} lines voiced`
                      : isNarrator ? "unassigned lines" : "no lines yet"}
                  </span>
                </span>
              </button>
            )
          })}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => openNew(null)}
            className="w-full justify-start"
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> New voice
          </Button>
        </div>
      </div>

      {editing.kind !== "closed" && (
        <CharacterModal
          open
          onClose={() => setEditing({ kind: "closed" })}
          voice={modalVoice}
          provider={provider}
          apiKey={apiKey}
          targetLanguage={targetLanguage}
          isDefault={modalVoice ? modalVoice.id === defaultVoiceId : false}
          projectId={projectId}
          fileId={fileId}
          session={session}
          cells={cells ?? []}
          onSave={saveVoice}
          onDelete={modalVoice ? () => deleteVoice(modalVoice) : undefined}
          onMakeDefault={modalVoice ? () => makeDefault(modalVoice) : undefined}
          seedCellId={modalSeed}
        />
      )}
    </div>
  )
}

/** DnD mime carrying a voice id dragged from a library card onto a production
 *  row (assigns the voice for that row's generation). */
export const VOICE_ASSIGN_MIME = "application/x-frontier-voice-assign"
