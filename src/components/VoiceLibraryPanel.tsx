// The Audio lens' Voices panel — a pure SELECTOR. One simple job: see your
// voices, pick which one is active, set the narrator. Making a voice is a single
// "New voice" button → NewVoiceModal, which carries every way to make one
// (TTS / Character / Train) behind tabs, seeded with the project's configured
// engine. Training from a line's take is hosted at the workspace root
// (CloneVoiceModalHost) so the modal does not depend on this panel being mounted.
//
// Click a row to select it (the active voice — the assign target). Drag a row
// onto a line to assign it. The row's ⋯ menu (and a right-click) edits /
// makes-narrator / deletes.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual"
import { Check, MoreHorizontal, Pencil, Plus, Search, Star, Trash2 } from "lucide-react"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { cn } from "@/lib/utils"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  MenuGroup,
  MenuItem,
  MenuSeparator,
  createMenuHandle,
} from "@/components/ui/menu-parts"
import type { ProjectTtsSettings, TtsProvider, Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { PRESET_VOICES, upsertVoice } from "@/lib/audio/voices"
import { voicesForLane } from "@/lib/audio/voice-lanes"
import { formatVoiceLanguageName, languageForVoiceDescription } from "@/lib/audio/inworld-languages"
import { providerInfo, resolveTtsProvider } from "@/lib/audio/tts-providers"
import { useCustomVoiceStatus } from "@/hooks/useCustomVoiceStatus"
import { NewVoiceModal } from "@/components/voice/NewVoiceModal"
import { VoiceNameWithLanguage } from "@/components/voice/VoiceLanguageBadge"
import { projectTargetLaneLanguages, showVoiceLanguageBadge } from "@/lib/audio/inworld-voices"
import type { FrontierSession } from "@/lib/frontier/types"
import { canManageVoices } from "@/lib/audio/voice-permission"
import { ROLE } from "@/lib/frontier/roles"
import { denialMessage } from "@/lib/permissions/denial"
import { AppTooltip } from "@/components/ui/tooltip"

/**
 * Rendered height of one voice row including the 2px gap below it (28px avatar
 * / two leading-tight lines + py-1.5). Only the virtualizer's first guess —
 * `measureElement` corrects it from real layout.
 */
const VOICE_ROW_PX = 44

/** Fallback scrollport size where layout reports none (happy-dom in tests). */
const FALLBACK_SCROLLPORT = { width: 320, height: 480 }

export interface CastMemberStats {
  /** Lines assigned to this cast member in the current file. */
  assigned: number
  /** Of the assigned lines, how many already have generated audio. */
  voiced: number
}

interface Props {
  targetLanguage?: string
  targetLanes?: string[]
  archivedLanes?: string[]
  settings: ProjectTtsSettings | undefined
  /**
   * AQU-2037: the open target lane's row id. The roster LISTS and COUNTS only
   * this lane's voices (plus the lane-less ones AQU-2039 has yet to migrate),
   * while every write still carries the project's whole library — this panel
   * owns that library, and writing back one lane's slice would delete the rest.
   * Null/absent on a project with no target lane rows: nothing is scoped then.
   */
  laneId?: string | null
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
  /**
   * AQU-365: the caller's resolved project role level (project.syncRole?.level),
   * or null/undefined for local projects with no live role (fail-open — same
   * convention as canPerform/resolveEditorCapabilities). Character/voice writes
   * mirror the server's `PUT/PATCH /projects/:id/settings` floor — maintainer
   * (600) — since that's the actual route this panel's writes flow through.
   */
  roleLevel?: number | null
  /**
   * AQU-2041. When the project lets project leads manage voices, a lead's
   * controls follow that instead of the maintainer floor. Contributors stay
   * blocked either way.
   */
  leadsManageVoices?: boolean
}

/** What the focused modal is doing right now. */
type Editing =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; voice: Voice }

export function VoiceLibraryPanel({
  targetLanguage, targetLanes, archivedLanes, settings, laneId, onSettingsChange, projectId, fileId, session,
  selectedVoiceId, onSelectVoice, castStats, cells, roleLevel, leadsManageVoices = false,
}: Props) {
  const t = useT()
  const [voices, setVoices] = useState<Voice[]>([])
  const [defaultVoiceId, setDefaultVoiceId] = useState<string | undefined>(undefined)
  const [localSelectedId, setLocalSelectedId] = useState<string>("")
  const seededRef = useRef<string | null>(null)
  const [editing, setEditing] = useState<Editing>({ kind: "closed" })
  const [query, setQuery] = useState("")
  const laneLanguages = useMemo(
    () => projectTargetLaneLanguages({ targetLanguage, targetLanes, archivedLanes }),
    [targetLanguage, targetLanes, archivedLanes],
  )
  const languageBadge = showVoiceLanguageBadge(laneLanguages)

  // AQU-365: character/voice writes flow through PUT/PATCH /settings, which
  // the server gates at maintainer (600). Fail-open (null roleLevel) for
  // local projects that never resolve a syncRole — same convention as
  // resolveEditorCapabilities / canPerform.
  const canEditVoices = canManageVoices(roleLevel, leadsManageVoices)
  const voiceDenialReason = !canEditVoices ? denialMessage(t, ROLE.MAINTAINER, roleLevel) : null

  // Keep the roster in sync with persisted settings so a voice created from
  // the in-cell New voice host (which writes through tts.saveTts) appears here
  // without a remount. First visit to a project still falls back to presets
  // when nothing has been saved yet.
  useEffect(() => {
    if (!projectId) return
    const projectChanged = seededRef.current !== projectId
    const stored = settings?.voices
    if (stored && stored.length > 0) {
      setVoices(stored)
      setDefaultVoiceId(settings?.defaultVoiceId ?? stored[0]?.id)
      if (projectChanged) {
        setLocalSelectedId(settings?.defaultVoiceId ?? stored[0]?.id ?? "")
        seededRef.current = projectId
      }
      return
    }
    if (!projectChanged) return
    const seed = [...PRESET_VOICES]
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
    const next = upsertVoice(voices, voice, defaultVoiceId)
    setVoices(next.voices)
    setDefaultVoiceId(next.defaultVoiceId)
    void onSettingsChange({ voices: next.voices, defaultVoiceId: next.defaultVoiceId })
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

  // AQU-2037: what this lane is OFFERED. Falls back to the presets when the
  // lane has none of its own, so a target lane added to a project whose voices
  // all belong elsewhere still lists the Narrator rather than nothing — the
  // same rule `laneVoiceLibrary` applies everywhere else.
  const laneVoices = useMemo(() => {
    if (!laneId) return voices
    const mine = voicesForLane(voices, laneId)
    return mine.length > 0 ? mine : [...PRESET_VOICES]
  }, [voices, laneId])

  // The active voice (the assign target) must be one this lane has: the stored
  // default can belong to another lane, and a highlight on a row that is not
  // listed would offer a cross-lane assignment.
  const laneSelectedId = laneVoices.some((v) => v.id === selectedId)
    ? selectedId
    : laneVoices[0]?.id ?? ""

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? laneVoices.filter((v) => v.name.toLowerCase().includes(q)) : laneVoices
  }, [laneVoices, query])

  // AQU-1940: a migrated project can carry tens of thousands of voices (one
  // was minted per verse label), and a row per voice took the whole library
  // into one synchronous render — the tab froze and Chrome killed it on
  // out-of-memory. Mount only the rows in or near the scrollport instead; the
  // header still counts every row the lane offers and search still scans all
  // of them (AQU-2037 narrowed both to the lane, not to the window).
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => filtered[index]?.id ?? index,
    estimateSize: () => VOICE_ROW_PX,
    overscan: 8,
    initialRect: FALLBACK_SCROLLPORT,
    // happy-dom reports 0x0 for CSS-sized scrollports; coerce so rows mount.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        cb({
          width: rect.width > 0 ? rect.width : FALLBACK_SCROLLPORT.width,
          height: rect.height > 0 ? rect.height : FALLBACK_SCROLLPORT.height,
        })
      }),
    // A row is a single truncated line, so the estimate is normally exact —
    // measure anyway so a taller row (language badge, zoomed text) cannot
    // drift the scroll height. Keep the estimate where layout reports nothing.
    measureElement: (element) => {
      const height = element.getBoundingClientRect().height
      return height > 0 ? height : VOICE_ROW_PX
    },
  })

  const handleScrollRef = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element
    if (element) rowVirtualizer.measure()
  }, [rowVirtualizer])

  // A voice without its own engine follows the project's configured one — the
  // same fallback generate-voice uses at synthesis time.
  const projectProvider = resolveTtsProvider(settings)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <h2 className="text-sm font-semibold">{t("common.voices")}</h2>
        <span className="text-xs text-muted-foreground">{laneVoices.length}</span>
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
            onChange={(e) => {
              setQuery(e.target.value)
              // Filtering a huge library while scrolled deep would otherwise
              // leave the virtual window past the end of the shorter results.
              if (scrollRef.current) scrollRef.current.scrollTop = 0
            }}
            placeholder={t("audio.library.searchPlaceholder")}
          />
        </InputGroup>
      </div>

      {/* The selector list — windowed, see AQU-1940 above. */}
      <div ref={handleScrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs italic text-muted-foreground">
            {query ? t("common.noMatches") : t("audio.library.noVoicesYet")}
          </p>
        ) : (
          <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((virtualItem) => {
              const voice = filtered[virtualItem.index]
              if (!voice) return null
              return (
                <div
                  key={virtualItem.key}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="absolute top-0 left-0 w-full pb-0.5"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <VoiceRow
                    voice={voice}
                    projectProvider={projectProvider}
                    showLanguageBadge={languageBadge}
                    active={voice.id === laneSelectedId}
                    isDefault={voice.id === defaultVoiceId}
                    stats={castStats?.get(voice.id)}
                    canEdit={canEditVoices}
                    onSelect={() => select(voice.id)}
                    onEdit={() => setEditing({ kind: "edit", voice })}
                    onMakeDefault={() => makeDefault(voice)}
                    onDelete={() => deleteVoice(voice)}
                    projectId={projectId}
                    fileId={fileId}
                    session={session}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* One button — the modal carries both ways to make a voice.
          AQU-365: disabled below the maintainer floor (viewers/contributors
          get a tooltip explaining why, not a silent no-op after a modal). */}
      <div className="border-t p-3">
        <AppTooltip
          content={voiceDenialReason ?? undefined}
          disabledTriggerClassName="w-full"
        >
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={!canEditVoices}
            onClick={() => setEditing({ kind: "create" })}
          >
            <Plus data-icon="inline-start" />
            {t("audio.newVoice.createLabel")}
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
          targetLanes={targetLanes}
          archivedLanes={archivedLanes}
          isDefault={editing.kind === "edit" ? editing.voice.id === defaultVoiceId : false}
          paletteIndex={voices.length}
          projectId={projectId}
          fileId={fileId}
          session={session}
          cells={cells ?? []}
          existingVoices={voices}
          onSave={saveVoice}
          onDelete={editing.kind === "edit" && canEditVoices ? () => deleteVoice(editing.voice) : undefined}
          onMakeDefault={editing.kind === "edit" && canEditVoices ? () => makeDefault(editing.voice) : undefined}
          initialMode="tts"
        />
      )}
    </div>
  )
}

function VoiceActionMenu({
  isDefault, canDelete, onEdit, onMakeDefault, onDelete,
}: {
  isDefault: boolean
  canDelete: boolean
  onEdit: () => void
  onMakeDefault: () => void
  onDelete: () => void
}) {
  const t = useT()
  return (
    <>
      <MenuGroup>
        <MenuItem onClick={onEdit}>
          <Pencil /> {t("common.edit")}
        </MenuItem>
        {!isDefault && (
          <MenuItem onClick={onMakeDefault}>
            <Star /> {t("audio.newVoice.makeNarratorButton")}
          </MenuItem>
        )}
      </MenuGroup>
      {canDelete && (
        <>
          <MenuSeparator />
          <MenuGroup>
            <MenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> {t("common.delete")}
            </MenuItem>
          </MenuGroup>
        </>
      )}
    </>
  )
}

/** A single selectable voice row: avatar · name · meta · narrator star ·
 *  selected check · hover ⋯ menu. Click selects; drag assigns onto a line.
 *  Right-click (and the ⋯ button) open the same items as a file-tab row. */
function VoiceRow({
  voice, projectProvider, showLanguageBadge, active, isDefault, stats, canEdit, onSelect, onEdit, onMakeDefault, onDelete,
  projectId, fileId, session,
}: {
  voice: Voice
  /** The project's configured TTS provider — the fallback for voices that
   *  don't carry their own (e.g. cast minted on import). */
  projectProvider: TtsProvider
  showLanguageBadge: boolean
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
  /** For polling a custom voice's training state. */
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
}) {
  const t = useT()
  const { locale } = useI18n()
  const customState = useCustomVoiceStatus(voice, { projectId, fileId, session })
  const actionsMenu = useMemo(() => createMenuHandle(), [])
  // Same resolution the synth path uses (CellTtsButton, generateAndAttachCellVoice):
  // a voice's own provider wins; an absent one falls back to the project's
  // configured engine — never a hardcoded "Gemini".
  const engineLabel = voice.customVoice
    ? customState === "ready"
      ? t("audio.library.customEngineLabel")
      : customState === "failed"
        ? t("audio.library.trainingFailedLabel")
        : t("audio.library.trainingEngineLabel")
    : voice.libraryVoiceId
    ? t("audio.library.characterEngineLabel")
    : providerInfo(voice.provider ?? projectProvider).shortTitle
  const languageTag = languageForVoiceDescription(voice.language)
  const languageName = languageTag ? formatVoiceLanguageName(languageTag, locale) : ""
  const actions = (
    <VoiceActionMenu
      isDefault={isDefault}
      canDelete={!voice.builtIn}
      onEdit={onEdit}
      onMakeDefault={onMakeDefault}
      onDelete={onDelete}
    />
  )
  const body = (
    <>
      <VoiceAvatar voice={voice} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium leading-tight">
          <VoiceNameWithLanguage
            name={voice.name}
            language={voice.language}
            showBadge={showLanguageBadge}
          />
        </span>
        <span className="block truncate text-[10px] leading-tight text-muted-foreground">
          <span className="font-medium">
            {engineLabel}
          </span>
          {languageName ? (
            <>
              {" · "}
              <span>{languageName}</span>
            </>
          ) : null}
          {" · "}
          {stats && stats.assigned > 0
            ? t("audio.library.voicedStats", { voiced: stats.voiced, assigned: stats.assigned })
            : isDefault ? t("audio.narrator") : t("audio.library.noLinesYet")}
        </span>
      </span>
      {isDefault && (
        <AppTooltip content={t("audio.narrator")}>
          <span
            aria-label={t("audio.narrator")}
            data-testid="voice-narrator-star"
            className="inline-flex shrink-0 text-muted-foreground"
          >
            <Star className="h-3.5 w-3.5 fill-current" />
          </span>
        </AppTooltip>
      )}
      {active && <Check data-testid="voice-row-selected" className="h-4 w-4 shrink-0 text-primary" />}
      {canEdit && (
        <DropdownMenuTrigger
          handle={actionsMenu}
          className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 aria-expanded:opacity-100 aria-expanded:text-foreground"
          onClick={(e) => e.stopPropagation()}
          aria-label={t("audio.library.moreActionsLabel")}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
      )}
    </>
  )
  const rowClass = cn(
    "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-start text-sm transition-colors",
    active ? "bg-primary/10" : "hover:bg-accent/50",
  )
  const rowProps = {
    role: "button" as const,
    tabIndex: 0,
    // Which voices are actually mounted is now a product fact (AQU-1940):
    // give the row a selector that does not depend on its label.
    "data-voice-id": voice.id,
    onClick: onSelect,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect() }
    },
    className: rowClass,
  }

  if (!canEdit) {
    return <div {...rowProps}>{body}</div>
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={<div {...rowProps} />}>
          {body}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">{actions}</ContextMenuContent>
      </ContextMenu>
      <DropdownMenu handle={actionsMenu}>
        <DropdownMenuContent align="end" className="w-44">
          {actions}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
