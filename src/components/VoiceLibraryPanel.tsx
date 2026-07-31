// The Audio lens' Voices panel — a pure SELECTOR. One simple job: see your
// voices, pick which one is active, set the narrator. Making a voice is a single
// "New voice" button → NewVoiceModal, which carries both ways to make one
// (TTS / Clone) behind tabs, seeded with the project's configured engine.
//
// Click a row to select it (the active voice — the assign target). Drag a row
// onto a line to assign it. The row's ⋯ menu edits / sets-narrator / deletes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, MoreHorizontal, Pencil, Plus, Search, Star, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { cn } from "@/lib/utils"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import type { ProjectTtsSettings, TtsProvider, Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { PRESET_VOICES } from "@/lib/audio/voices"
import { providerInfo, resolveTtsProvider } from "@/lib/audio/tts-providers"
import { NewVoiceModal } from "@/components/voice/NewVoiceModal"
import type { FrontierSession } from "@/lib/frontier/types"
import { ROLE } from "@/lib/frontier/roles"
import { denialMessage } from "@/lib/permissions/denial"
import { AppTooltip } from "@/components/ui/tooltip"

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
  /**
   * AQU-365: the caller's resolved project role level (project.syncRole?.level),
   * or null/undefined for local projects with no live role (fail-open — same
   * convention as canPerform/resolveEditorCapabilities). Character/voice writes
   * mirror the server's `PUT/PATCH /projects/:id/settings` floor — maintainer
   * (600) — since that's the actual route this panel's writes flow through.
   */
  roleLevel?: number | null
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
  roleLevel,
}: Props) {
  const [voices, setVoices] = useState<Voice[]>([])
  const [defaultVoiceId, setDefaultVoiceId] = useState<string | undefined>(undefined)
  const [localSelectedId, setLocalSelectedId] = useState<string>("")
  const seededRef = useRef<string | null>(null)
  const [editing, setEditing] = useState<Editing>({ kind: "closed" })
  const [query, setQuery] = useState("")

  // AQU-365: character/voice writes flow through PUT/PATCH /settings, which
  // the server gates at maintainer (600). Fail-open (null roleLevel) for
  // local projects that never resolve a syncRole — same convention as
  // resolveEditorCapabilities / canPerform.
  const canEditVoices = roleLevel == null || roleLevel >= ROLE.MAINTAINER
  const voiceDenialReason = !canEditVoices ? denialMessage(ROLE.MAINTAINER, roleLevel) : null

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

  // AQU-365: writeBack/saveVoice are the character-CRUD write path (mirrors
  // PUT/PATCH /settings, maintainer-gated server-side). A below-floor caller
  // must not get even a LOCAL echo of the write — otherwise their own
  // localStorage/IDB looks like it "saved" even though the server 403s the
  // sync, which is the false-positive UX this ticket calls out.
  const writeBack = useCallback((nextVoices: Voice[], nextDefault: string | undefined) => {
    if (!canEditVoices) return
    setVoices(nextVoices)
    setDefaultVoiceId(nextDefault)
    void onSettingsChange({ voices: nextVoices, defaultVoiceId: nextDefault })
  }, [onSettingsChange, canEditVoices])

  // Append-or-replace + select. (Computed outside the updater to avoid React's
  // "setState during render" warning.)
  const saveVoice = useCallback((voice: Voice) => {
    if (!canEditVoices) return
    const exists = voices.some((v) => v.id === voice.id)
    const next = exists ? voices.map((v) => (v.id === voice.id ? voice : v)) : [...voices, voice]
    const nextDefault = defaultVoiceId ?? next[0]?.id
    setVoices(next)
    setDefaultVoiceId(nextDefault)
    void onSettingsChange({ voices: next, defaultVoiceId: nextDefault })
    select(voice.id)
  }, [voices, defaultVoiceId, onSettingsChange, select, canEditVoices])

  const deleteVoice = useCallback((voice: Voice) => {
    if (!canEditVoices) return
    const next = voices.filter((v) => v.id !== voice.id)
    const nextDefault = defaultVoiceId === voice.id ? next[0]?.id : defaultVoiceId
    if (selectedId === voice.id) select(next[0]?.id ?? "")
    writeBack(next, nextDefault)
  }, [voices, defaultVoiceId, selectedId, writeBack, select, canEditVoices])

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

  // A voice without its own engine follows the project's configured one — the
  // same fallback generate-voice uses at synthesis time.
  const projectProvider = resolveTtsProvider(settings)

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
              projectProvider={projectProvider}
              active={voice.id === selectedId}
              isDefault={voice.id === defaultVoiceId}
              stats={castStats?.get(voice.id)}
              canEdit={canEditVoices}
              onSelect={() => select(voice.id)}
              onEdit={() => setEditing({ kind: "edit", voice })}
              onMakeDefault={() => makeDefault(voice)}
              onDelete={() => deleteVoice(voice)}
            />
          ))
        )}
      </div>

      {/* One button — the modal carries both ways to make a voice.
          AQU-365: disabled below the maintainer floor (viewers/contributors
          get a tooltip explaining why, not a silent no-op after a modal). */}
      <div className="border-t p-3">
        <AppTooltip content={voiceDenialReason ?? undefined}>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={!canEditVoices}
            onClick={() => setEditing({ kind: "create" })}
          >
            <Plus data-icon="inline-start" />
            New voice
          </Button>
        </AppTooltip>
      </div>

      {editing.kind !== "closed" && (
        <NewVoiceModal
          open
          onClose={() => setEditing({ kind: "closed" })}
          voice={editing.kind === "edit" ? editing.voice : null}
          provider={projectProvider}
          targetLanguage={targetLanguage}
          isDefault={editing.kind === "edit" ? editing.voice.id === defaultVoiceId : false}
          paletteIndex={voices.length}
          projectId={projectId}
          fileId={fileId}
          session={session}
          cells={cells ?? []}
          onSave={saveVoice}
          onDelete={editing.kind === "edit" && canEditVoices ? () => deleteVoice(editing.voice) : undefined}
          onMakeDefault={editing.kind === "edit" && canEditVoices ? () => makeDefault(editing.voice) : undefined}
          initialMode={editing.kind === "clone" ? "clone" : "tts"}
          seedCellId={editing.kind === "clone" ? editing.seedCellId : null}
        />
      )}
    </div>
  )
}

/** A single selectable voice row: avatar · name · meta · narrator star ·
 *  selected check · hover ⋯ menu. Click selects; drag assigns onto a line. */
function VoiceRow({
  voice, projectProvider, active, isDefault, stats, canEdit, onSelect, onEdit, onMakeDefault, onDelete,
}: {
  voice: Voice
  /** The project's configured TTS provider — the fallback for voices that
   *  don't carry their own (e.g. cast minted on import). */
  projectProvider: TtsProvider
  active: boolean
  isDefault: boolean
  stats?: CastMemberStats
  /** AQU-365: whether the caller may edit/delete/set-narrator. Selecting a
   *  voice (to assign to lines) is always allowed — only the ⋯ menu (character
   *  CRUD) is gated. */
  canEdit: boolean
  onSelect: () => void
  onEdit: () => void
  onMakeDefault: () => void
  onDelete: () => void
}) {
  // Same resolution the synth path uses (CellTtsButton, generateAndAttachCellVoice):
  // a voice's own provider wins; an absent one falls back to the project's
  // configured engine — never a hardcoded "Gemini".
  const engineLabel = voice.referenceAudioId
    ? "Clone"
    : providerInfo(voice.provider ?? projectProvider).shortTitle
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <AppTooltip content="Click to select · drag onto a line to assign">
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
        className={cn(
          "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
          active ? "bg-primary/10" : "hover:bg-accent/50",
        )}
      >
      <VoiceAvatar voice={voice} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium leading-tight">{voice.name}</span>
        <span className="block truncate text-[10px] leading-tight text-muted-foreground">
          <span className={cn("font-medium", voice.referenceAudioId && "text-emerald-600 dark:text-emerald-400")}>
            {engineLabel}
          </span>
          {" · "}
          {stats && stats.assigned > 0
            ? `${stats.voiced}/${stats.assigned} voiced`
            : isDefault ? "narrator" : "no lines yet"}
        </span>
      </span>
      {isDefault && (
        <AppTooltip content="Narrator — lines without an explicit speaker use this voice.">
          <Badge
            variant="secondary"
            className="shrink-0 gap-1 text-[9px]"
          >
            <Star data-icon="inline-start" /> Narrator
          </Badge>
        </AppTooltip>
      )}
      {/* AQU-365: the ⋯ menu is character CRUD (edit/set-narrator/delete) —
          hidden below the maintainer floor. Selecting/dragging a voice to
          assign it to a line stays available (a separate, lower-floor
          concern this ticket doesn't touch). */}
      {canEdit && (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <AppTooltip content="More">
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="More voice actions"
                  className="shrink-0 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
                >
                  <MoreHorizontal />
                </Button>
              }
            />
          </AppTooltip>
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
      )}
      {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
      </div>
    </AppTooltip>
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
    <Button
      type="button"
      variant={destructive ? "destructive" : "ghost"}
      size="sm"
      onClick={onClick}
      className="w-full justify-start"
    >
      <Icon data-icon="inline-start" />
      {label}
    </Button>
  )
}

/** DnD mime carrying a voice id dragged from a row onto a production line. */
export const VOICE_ASSIGN_MIME = "application/x-frontier-voice-assign"
