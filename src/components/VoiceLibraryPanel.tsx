// The Audio lens' Voices panel — a pure SELECTOR. One simple job: see your
// voices, pick which one is active, set the narrator. Making a voice is a single
// "New voice" button → NewVoiceModal, which carries both ways to make one
// (Gemini / Clone) behind tabs.
//
// Click a row to select it (the active voice — the assign target). Drag a row
// onto a line to assign it. The row's ⋯ menu edits / sets-narrator / deletes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, MoreHorizontal, Pencil, Plus, Search, Star, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { cn } from "@/lib/utils"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { PRESET_VOICES } from "@/lib/audio/voices"
import { NewVoiceModal } from "@/components/voice/NewVoiceModal"
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
  /** The active voice — its lines highlight and it's the assign target. */
  selectedVoiceId?: string
  onSelectVoice?: (voiceId: string) => void
  /** Per-member line counts for the current file (voiceId → stats). */
  castStats?: Map<string, CastMemberStats>
  /** All cells, so cloning can reuse a take from a line. */
  cells?: CellData[]
  /** The per-cell "clone from this take" seed (opens the clone workflow). */
  seedCellId?: string | null
  seedSignal?: number
}

/** What the focused modal is doing right now. */
type Editing =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; voice: Voice }
  | { kind: "clone"; seedCellId: string | null }

export function VoiceLibraryPanel({
  targetLanguage, settings, onSettingsChange, projectId, fileId, session,
  selectedVoiceId, onSelectVoice, castStats, cells, seedCellId, seedSignal,
}: Props) {
  const [voices, setVoices] = useState<Voice[]>([])
  const [defaultVoiceId, setDefaultVoiceId] = useState<string | undefined>(undefined)
  const [localSelectedId, setLocalSelectedId] = useState<string>("")
  const seededRef = useRef<string | null>(null)
  const [editing, setEditing] = useState<Editing>({ kind: "closed" })
  const [query, setQuery] = useState("")

  // Seed the local library once per project.
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

  // Append-or-replace + select. (Computed outside the updater to avoid React's
  // "setState during render" warning.)
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
    if (selectedId === voice.id) select(next[0]?.id ?? "")
    writeBack(next, nextDefault)
  }, [voices, defaultVoiceId, selectedId, writeBack, select])

  const makeDefault = useCallback((voice: Voice) => writeBack(voices, voice.id), [voices, writeBack])

  // The per-cell "clone from this take" opens the clone workflow seeded.
  useEffect(() => {
    if (!seedSignal) return
    setEditing({ kind: "clone", seedCellId: seedCellId ?? null })
  }, [seedSignal, seedCellId])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? voices.filter((v) => v.name.toLowerCase().includes(q)) : voices
  }, [voices, query])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <h2 className="text-sm font-semibold">Voices</h2>
        <span className="text-xs text-muted-foreground">{voices.length}</span>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search voices…"
          />
        </InputGroup>
      </div>

      {/* The selector list */}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs italic text-muted-foreground">
            {query ? "No matches" : "No voices yet"}
          </p>
        ) : (
          filtered.map((voice) => (
            <VoiceRow
              key={voice.id}
              voice={voice}
              active={voice.id === selectedId}
              isDefault={voice.id === defaultVoiceId}
              stats={castStats?.get(voice.id)}
              onSelect={() => select(voice.id)}
              onEdit={() => setEditing({ kind: "edit", voice })}
              onMakeDefault={() => makeDefault(voice)}
              onDelete={() => deleteVoice(voice)}
            />
          ))
        )}
      </div>

      {/* One button — the modal carries both ways to make a voice. */}
      <div className="border-t p-3">
        <Button
          type="button"
          variant="outline"
          className="w-full justify-center border-dashed"
          onClick={() => setEditing({ kind: "create" })}
        >
          <Plus className="mr-2 h-4 w-4" /> New voice
        </Button>
      </div>

      {editing.kind !== "closed" && (
        <NewVoiceModal
          open
          onClose={() => setEditing({ kind: "closed" })}
          voice={editing.kind === "edit" ? editing.voice : null}
          targetLanguage={targetLanguage}
          isDefault={editing.kind === "edit" ? editing.voice.id === defaultVoiceId : false}
          paletteIndex={voices.length}
          projectId={projectId}
          fileId={fileId}
          session={session}
          cells={cells ?? []}
          onSave={saveVoice}
          onDelete={editing.kind === "edit" ? () => deleteVoice(editing.voice) : undefined}
          onMakeDefault={editing.kind === "edit" ? () => makeDefault(editing.voice) : undefined}
          initialMode={editing.kind === "clone" ? "clone" : "gemini"}
          seedCellId={editing.kind === "clone" ? editing.seedCellId : null}
        />
      )}
    </div>
  )
}

/** A single selectable voice row: avatar · name · meta · narrator star ·
 *  selected check · hover ⋯ menu. Click selects; drag assigns onto a line. */
function VoiceRow({
  voice, active, isDefault, stats, onSelect, onEdit, onMakeDefault, onDelete,
}: {
  voice: Voice
  active: boolean
  isDefault: boolean
  stats?: CastMemberStats
  onSelect: () => void
  onEdit: () => void
  onMakeDefault: () => void
  onDelete: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(VOICE_ASSIGN_MIME, voice.id)
        e.dataTransfer.effectAllowed = "copy"
      }}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect() } }}
      title="Click to select · drag onto a line to assign"
      className={cn(
        "group flex cursor-grab items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors active:cursor-grabbing",
        active ? "bg-primary/10" : "hover:bg-accent/50",
      )}
    >
      <VoiceAvatar voice={voice} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium leading-tight">{voice.name}</span>
        <span className="block truncate text-[10px] leading-tight text-muted-foreground">
          <span className={cn("font-medium", voice.referenceAudioId && "text-emerald-600 dark:text-emerald-400")}>
            {voice.referenceAudioId ? "Clone" : "Gemini"}
          </span>
          {" · "}
          {stats && stats.assigned > 0
            ? `${stats.voiced}/${stats.assigned} voiced`
            : isDefault ? "narrator" : "no lines yet"}
        </span>
      </span>
      {isDefault && (
        <span
          title="Narrator — lines without an explicit speaker use this voice."
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
        >
          <Star className="h-2.5 w-2.5" /> Narrator
        </span>
      )}
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              title="More"
              aria-label="More voice actions"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          }
        />
        <PopoverContent align="end" side="bottom" className="w-44 p-1" onClick={(e) => e.stopPropagation()}>
          <MenuItem icon={Pencil} label="Edit" onClick={() => { setMenuOpen(false); onEdit() }} />
          {!isDefault && (
            <MenuItem icon={Star} label="Set as narrator" onClick={() => { setMenuOpen(false); onMakeDefault() }} />
          )}
          {!voice.builtIn && (
            <MenuItem
              icon={Trash2}
              label="Delete"
              destructive
              onClick={() => { setMenuOpen(false); onDelete() }}
            />
          )}
        </PopoverContent>
      </Popover>
      {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </div>
  )
}

function MenuItem({
  icon: Icon, label, onClick, destructive,
}: {
  icon: typeof Pencil
  label: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50",
        destructive && "text-destructive hover:bg-destructive/10",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  )
}

/** DnD mime carrying a voice id dragged from a row onto a production line. */
export const VOICE_ASSIGN_MIME = "application/x-frontier-voice-assign"
