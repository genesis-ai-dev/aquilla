// The Voice Studio's left rail: a calm CAST ROSTER. The engine + Gemini key sit
// in a small collapsible bit; below it is a clean list of characters (color dot,
// name, line count, default star, character-voice badge) plus "+ New character".
//
// Crafting a character is a focused act — clicking a character (or "+ New
// character") opens the CharacterModal (the "character creator"), not an
// always-open inline inspector. A show often has ONE voice actor; characters are
// how that single actor becomes many distinct voices. Each character just has a
// VOICE SOURCE (a preset engine voice OR a reference recording); a reference
// makes it what we used to call a "clone". There is no separate clone concept.

import { useCallback, useEffect, useRef, useState } from "react"
import { KeyRound, Plus, Settings2, Sparkles, Star, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { PRESET_VOICES } from "@/lib/audio/voices"
import { DEFAULT_TTS_PROVIDER, TTS_PROVIDER_INFOS } from "@/lib/audio/tts-providers"
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

/** A character being edited in the modal: an existing voice, or null = new. */
type Editing =
  | { kind: "closed" }
  | { kind: "edit"; voice: Voice }
  | { kind: "new"; seedCellId: string | null }

export function VoiceLibraryPanel({
  targetLanguage, settings, onSettingsChange, projectId, fileId, session,
  selectedVoiceId, onSelectVoice, castStats, cells, seedCellId, seedSignal,
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
  const saveVoice = useCallback((voice: Voice) => {
    setVoices((cur) => {
      const exists = cur.some((v) => v.id === voice.id)
      const next = exists ? cur.map((v) => (v.id === voice.id ? voice : v)) : [...cur, voice]
      const nextDefault = defaultVoiceId ?? next[0]?.id
      setDefaultVoiceId(nextDefault)
      void onSettingsChange({ voices: next, defaultVoiceId: nextDefault })
      return next
    })
    select(voice.id)
  }, [defaultVoiceId, onSettingsChange, select])

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
        {/* Engine — a small collapsible bit so the key + provider stay calm. */}
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

        {/* Cast roster — one row per character. Click opens the creator; drag
            onto a line assigns the voice for that row's generation. */}
        <div className="space-y-1">
          {voices.map((voice) => {
            const active = voice.id === selectedId
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
                onClick={() => openEdit(voice)}
                title="Click to craft · drag onto a line to assign"
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
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => openNew(null)}
            className="w-full justify-start"
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> New character
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
