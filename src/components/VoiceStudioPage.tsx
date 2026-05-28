// Voice Studio — produce a dramatized audio edition of a project
// (/project/:id/voice). Built for the audio-Bible / episodic-drama workflow:
// define a CAST of characters (each a base TTS voice + an optional actor-clone
// reference), assign each line to a character, then bulk-generate the whole
// file in the actors' cloned voices.
//
// It deliberately mirrors the translate editor: the same neumorphic cell cards,
// the same number/label pill, the same multi-select — but the cell body is
// read-only target text plus a speaker chip and audio controls. Translation
// editing stays on the translate page; this is the audio view.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  AlertCircle, ArrowLeft, CheckCircle2, Loader2, Mic, Pause, Play, RefreshCw,
  SkipBack, SkipForward, Sparkles, Square, Volume2, X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { getProject, patchProject } from "@/lib/store/project-index"
import { useProject } from "@/hooks/useProject"
import { useCells } from "@/hooks/useCells"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getVoiceLibrary, resolveVoice, resolveCastVoice, assignedCastVoiceId } from "@/lib/audio/voices"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { setTtsStatus, ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { categorizeAiError } from "@/lib/audio/ai-error"
import {
  clearSelection, toggleSelected, useIsSelected, useSelectedIds,
} from "@/lib/audio/selection"
import {
  hasAnyPlayableAudio, pauseQueue, resumeQueue, skipBack, skipForward,
  startQueue, stopQueue, updateQueueCells, useQueueState,
} from "@/lib/audio/play-queue"
import { CellTtsButton } from "./CellTtsButton"
import { CellAiStatusPopover } from "./CellAiStatusPopover"
import { CellNumberPill } from "./cell/CellNumberPill"
import { cellCardClassName } from "./cell/cellCard"
import { EditorModeToggle } from "./EditorModeToggle"
import { VoiceLibraryPanel, VOICE_ASSIGN_MIME, type CastMemberStats } from "./VoiceLibraryPanel"
import { AudioRecordingModal } from "./AudioRecorder/AudioRecordingModal"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings, Voice } from "@/lib/parsers/types"

export function VoiceStudioPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { session } = useFrontierSession()
  const { project: serverProject, status } = useProject(id ?? "")
  const loading = status === "loading"
  const [fileId, setFileId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  const [recordCellId, setRecordCellId] = useState<string | null>(null)
  // The active cast member in the rail — its lines highlight, and it's the
  // one-click assign target for the selection bar.
  const [activeCastId, setActiveCastId] = useState<string | undefined>(undefined)
  // TTS settings (engine, cast, key, assignments) live in local IDB; useProject
  // returns the server record without them, so we hydrate + overlay separately.
  const [localTts, setLocalTts] = useState<ProjectTtsSettings | undefined>(undefined)

  useEffect(() => {
    if (!id) return
    void getProject(id).then((p) => { if (p) setLocalTts(p.ttsSettings) })
  }, [id])

  const project = useMemo<ProjectRecord | null>(() => {
    if (!serverProject) return null
    return { ...serverProject, ttsSettings: localTts ?? serverProject.ttsSettings }
  }, [serverProject, localTts])

  useEffect(() => {
    if (!project) return
    setFileId((cur) => cur ?? project.files[0]?.id ?? null)
  }, [project])

  // Clear any leftover multi-selection when entering / leaving the studio.
  useEffect(() => () => clearSelection(), [])

  const username = session?.username ?? project?.username ?? "anonymous"

  const getToken = useMemo(() => {
    const fetcher = audioSyncTokenFetcherForSession(session ?? null)
    return (fid: string) => (id ? fetcher(id, fid) : Promise.resolve(null))
  }, [session, id])

  const { cells, revalidate, isLoading: cellsLoading } = useCells({
    projectId: id ?? null,
    fileId,
    username,
    getToken,
    enabled: Boolean(id && fileId && session?.jwt),
  })

  const settings = project?.ttsSettings
  const voices = useMemo(() => getVoiceLibrary(settings), [settings])
  const defaultVoiceId = useMemo(() => resolveVoice(settings, undefined).id, [settings])
  const voicesById = useMemo(() => {
    const m = new Map<string, Voice>()
    for (const v of voices) m.set(v.id, v)
    return m
  }, [voices])

  const saveTts = useCallback(
    async (overrides: Partial<ProjectTtsSettings>) => {
      if (!id) return
      setLocalTts((cur) => ({ ...(cur ?? {}), ...overrides } as ProjectTtsSettings))
      await patchProject(id, (p) => ({ ...p, ttsSettings: { ...p.ttsSettings, ...overrides } }))
    },
    [id],
  )

  const generatableCells = useMemo(
    () => cells.filter((c) => c.type !== "paratext" && c.translated?.trim()),
    [cells],
  )
  const voicedCount = generatableCells.filter((c) => c.selectedGeneratedVoiceAudioId).length
  const pendingCount = generatableCells.length - voicedCount
  const recordedCount = generatableCells.filter((c) => c.selectedAudioId).length
  const firstUnrecordedCellId = useMemo(
    () => generatableCells.find((c) => !c.selectedAudioId)?.id ?? generatableCells[0]?.id ?? null,
    [generatableCells],
  )

  // Per-cast line counts for the rail (assigned + already-voiced). Unassigned
  // lines roll up to the default/narrator member so its count reflects reality.
  const castStats = useMemo(() => {
    const m = new Map<string, CastMemberStats>()
    const bump = (vid: string, voiced: boolean) => {
      const s = m.get(vid) ?? { assigned: 0, voiced: 0 }
      s.assigned += 1
      if (voiced) s.voiced += 1
      m.set(vid, s)
    }
    for (const c of generatableCells) {
      const vid = assignedCastVoiceId(settings, c.id) ?? defaultVoiceId
      bump(vid, Boolean(c.selectedGeneratedVoiceAudioId))
    }
    return m
  }, [generatableCells, settings, defaultVoiceId])

  // ── Assignment ───────────────────────────────────────────────────────────
  const assignCells = useCallback(
    (cellIds: Iterable<string>, voiceId: string) => {
      const next = { ...(settings?.castAssignments ?? {}) }
      for (const cid of cellIds) next[cid] = voiceId
      void saveTts({ castAssignments: next })
    },
    [settings, saveTts],
  )

  const selectedIds = useSelectedIds()

  const generateOne = useCallback(
    async (cell: CellData) => {
      if (!project) return
      setBusy((s) => new Set(s).add(cell.id))
      const ok = await generateCellVoice({
        project, cell, session: session ?? null, username,
        voiceId: resolveCastVoice(project.ttsSettings, cell.id, cell.ttsSettings?.voiceId).id,
      })
      setBusy((s) => { const n = new Set(s); n.delete(cell.id); return n })
      if (ok) revalidate()
    },
    [project, session, username, revalidate],
  )

  const generateAll = useCallback(async () => {
    if (!project || batchProgress) return
    const queue = generatableCells.filter((c) => !c.selectedGeneratedVoiceAudioId)
    if (queue.length === 0) return
    setBatchProgress({ done: 0, total: queue.length })
    for (let i = 0; i < queue.length; i++) {
      await generateCellVoice({
        project, cell: queue[i], session: session ?? null, username,
        voiceId: resolveCastVoice(project.ttsSettings, queue[i].id, queue[i].ttsSettings?.voiceId).id,
      })
      setBatchProgress({ done: i + 1, total: queue.length })
    }
    setBatchProgress(null)
    revalidate()
  }, [project, batchProgress, generatableCells, session, username, revalidate])

  // ── Read-along playback ────────────────────────────────────────────────
  const queue = useQueueState()
  const playingCellId = queue.kind === "playing" || queue.kind === "loading" || queue.kind === "paused"
    ? queue.cellId
    : undefined
  const canPlay = hasAnyPlayableAudio(cells)

  useEffect(() => { updateQueueCells(cells) }, [cells])
  useEffect(() => () => stopQueue(), [])

  const togglePlayAll = useCallback(() => {
    if (queue.kind === "playing") { pauseQueue(); return }
    if (queue.kind === "paused") { void resumeQueue(); return }
    if (!id || !session?.jwt) return
    startQueue(
      { cells, projectId: id, session, onCellChange: (_i, cid) => scrollRowIntoView(cid) },
      0,
    )
  }, [queue.kind, id, session, cells])

  // ── Virtualized list ──────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: generatableCells.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 68,
    overscan: 8,
  })

  if (loading) return <div className="p-8 text-muted-foreground">Loading…</div>
  if (!project || !id) return <div className="p-8 text-muted-foreground">Project not found.</div>

  const coveragePct = generatableCells.length ? (voicedCount / generatableCells.length) * 100 : 0

  return (
    <div className="flex h-screen flex-col">
      {/* Header — identical to translate mode */}
      <header className="flex items-center gap-3 border-b bg-background px-4 py-2">
        <button
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => navigate(`/project/${id}`)}
        >
          <ArrowLeft className="h-4 w-4" /> {project.name}
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">Voice Studio</span>
        <div className="flex-1" />
        <EditorModeToggle projectId={id} mode="voice" />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left rail — cast */}
        <aside className="w-[340px] shrink-0 border-r bg-muted/10">
          <VoiceLibraryPanel
            settings={project.ttsSettings}
            onSettingsChange={saveTts}
            targetLanguage={project.targetLanguage}
            projectId={id}
            fileId={fileId}
            session={session ?? null}
            castStats={castStats}
            selectedVoiceId={activeCastId}
            onSelectVoice={setActiveCastId}
          />
        </aside>

        {/* Right — transport + cast list */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Transport bar */}
          <div className="flex items-center gap-3 border-b bg-background px-4 py-2">
            <div className="flex items-center gap-1">
              <Button
                variant="outline" size="icon" className="h-8 w-8"
                onClick={() => skipBack()} disabled={!canPlay || queue.kind === "idle"} title="Previous"
              >
                <SkipBack className="h-4 w-4" />
              </Button>
              <Button
                variant="default" size="icon" className="h-9 w-9"
                onClick={togglePlayAll} disabled={!canPlay}
                title={queue.kind === "playing" ? "Pause" : "Play through"}
              >
                {queue.kind === "loading" ? <Loader2 className="h-4 w-4 animate-spin" />
                  : queue.kind === "playing" ? <Pause className="h-4 w-4" />
                  : <Play className="h-4 w-4" />}
              </Button>
              <Button
                variant="outline" size="icon" className="h-8 w-8"
                onClick={() => skipForward()} disabled={!canPlay || queue.kind === "idle"} title="Next"
              >
                <SkipForward className="h-4 w-4" />
              </Button>
              {queue.kind !== "idle" && (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => stopQueue()} title="Stop">
                  <Square className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${coveragePct}%` }} />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {voicedCount}/{generatableCells.length} voiced
              </span>
            </div>

            {project.files.length > 1 && (
              <select
                value={fileId ?? ""}
                onChange={(e) => { stopQueue(); clearSelection(); setFileId(e.target.value) }}
                className="rounded border bg-background px-2 py-1 text-xs"
              >
                {project.files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            )}

            <Button
              variant="outline" size="sm" className="h-8"
              onClick={() => { if (firstUnrecordedCellId) { stopQueue(); setRecordCellId(firstUnrecordedCellId) } }}
              disabled={!firstUnrecordedCellId || Boolean(batchProgress)}
              title="Record takes — booth mode (Space to start, ←/→ to navigate)"
            >
              <Mic className="mr-1 h-3.5 w-3.5" /> Record
              <span className="ml-1 tabular-nums opacity-70">({recordedCount}/{generatableCells.length})</span>
            </Button>

            {batchProgress ? (
              <Button variant="outline" size="sm" disabled className="h-8">
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                <span className="tabular-nums">{batchProgress.done}/{batchProgress.total}</span>
              </Button>
            ) : (
              <Button variant="default" size="sm" className="h-8" onClick={() => void generateAll()} disabled={pendingCount === 0}>
                <Sparkles className="mr-1 h-3.5 w-3.5" /> Generate all
                {pendingCount > 0 && <span className="ml-1 tabular-nums opacity-80">({pendingCount})</span>}
              </Button>
            )}
          </div>

          {/* Cast list (virtualized) */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {cellsLoading && generatableCells.length === 0 ? (
              <div className="p-8 text-muted-foreground">Loading lines…</div>
            ) : generatableCells.length === 0 ? (
              <div className="p-8 text-muted-foreground">
                No translated lines in this file yet. Translate first, then cast and voice them here.
              </div>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((vi) => {
                  const cell = generatableCells[vi.index]
                  const assignedId = assignedCastVoiceId(settings, cell.id) ?? defaultVoiceId
                  const voice = voicesById.get(assignedId)
                  return (
                    <div
                      key={cell.id}
                      ref={virtualizer.measureElement}
                      data-index={vi.index}
                      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
                      className="pb-2"
                    >
                      <ProductionRow
                        cell={cell}
                        project={project}
                        projectId={id}
                        voice={voice}
                        voices={voices}
                        hasAudio={Boolean(cell.selectedGeneratedVoiceAudioId)}
                        hasRecording={Boolean(cell.selectedAudioId)}
                        isBusy={busy.has(cell.id)}
                        batchRunning={Boolean(batchProgress)}
                        isPlaying={cell.id === playingCellId}
                        dimmed={Boolean(activeCastId) && assignedId !== activeCastId}
                        onAssign={(vid) => assignCells([cell.id], vid)}
                        onGenerate={() => void generateOne(cell)}
                        onRecord={() => { stopQueue(); setRecordCellId(cell.id) }}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Assign bar — appears when lines are multi-selected */}
          {selectedIds.size > 0 && (
            <AssignBar
              count={selectedIds.size}
              voices={voices}
              activeCastId={activeCastId}
              onAssign={(vid) => { assignCells(selectedIds, vid); clearSelection() }}
              onClear={() => clearSelection()}
            />
          )}
        </div>
      </div>

      <AudioRecordingModal
        open={recordCellId !== null}
        project={project}
        cells={generatableCells}
        activeCellId={recordCellId}
        username={username}
        onActiveCellChange={(cid) => setRecordCellId(cid)}
        onClose={() => setRecordCellId(null)}
      />
    </div>
  )
}

function scrollRowIntoView(cellId: string) {
  document.getElementById(`vs-row-${cellId}`)?.scrollIntoView({ block: "center", behavior: "smooth" })
}

// ── Production row ──────────────────────────────────────────────────────────

interface RowProps {
  cell: CellData
  project: ProjectRecord
  projectId: string
  voice: Voice | undefined
  voices: Voice[]
  hasAudio: boolean
  hasRecording: boolean
  isBusy: boolean
  batchRunning: boolean
  isPlaying: boolean
  /** Faded because the rail has a different character selected. */
  dimmed: boolean
  onAssign: (voiceId: string) => void
  onGenerate: () => void
  onRecord: () => void
}

function ProductionRow({
  cell, project, projectId, voice, voices, hasAudio, hasRecording,
  isBusy, batchRunning, isPlaying, dimmed, onAssign, onGenerate, onRecord,
}: RowProps) {
  const [dropActive, setDropActive] = useState(false)
  const selected = useIsSelected(cell.id)
  const status = useTtsStatus(ttsStatusKey(cell.id))
  const isError = status.kind === "error"
  const isLoading = status.kind === "loading" || status.kind === "synthesizing"

  return (
    <div
      id={`vs-row-${cell.id}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(VOICE_ASSIGN_MIME)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = "copy"
          if (!dropActive) setDropActive(true)
        }
      }}
      onDragLeave={() => dropActive && setDropActive(false)}
      onDrop={(e) => {
        const vid = e.dataTransfer.getData(VOICE_ASSIGN_MIME)
        setDropActive(false)
        if (vid) { e.preventDefault(); onAssign(vid) }
      }}
      className={cn(
        cellCardClassName({
          selected, raised: isPlaying, busy: isLoading, error: isError, dropTarget: dropActive,
        }),
        "flex items-center gap-3 px-3 py-2",
        dimmed && "opacity-45",
      )}
    >
      {/* Selection checkbox */}
      <button
        type="button"
        onClick={() => toggleSelected(cell.id)}
        aria-pressed={selected}
        title={selected ? "Deselect line" : "Select line"}
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40 hover:border-foreground",
        )}
      >
        {selected && <CheckCircle2 className="h-3 w-3" />}
      </button>

      <CellNumberPill label={cell.cellLabel ?? cell.id.slice(0, 6)} className="self-start" />

      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-sm leading-snug">{cell.translated?.trim()}</div>
      </div>

      {/* Speaker chip — assigned cast member; click to reassign */}
      <SpeakerChip voice={voice} voices={voices} onAssign={onAssign} />

      {/* Status */}
      <div className="w-16 shrink-0 text-right">
        {isError ? <CellVoiceError cellId={cell.id} />
          : isLoading ? (
            <span className="inline-flex items-center gap-1 text-xs text-primary">
              <Loader2 className="h-3 w-3 animate-spin" /> Voicing
            </span>
          ) : hasAudio ? (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> Ready
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/50">—</span>
          )}
      </div>

      {hasAudio && (
        <CellTtsButton
          cellId={cell.id}
          text={cell.translated}
          original={cell.original}
          context={cell.context}
          cellLabel={cell.cellLabel}
          sourceLanguage={project.sourceLanguage}
          targetLanguage={project.targetLanguage}
          projectTtsSettings={project.ttsSettings}
          cellTtsSettings={cell.ttsSettings}
          generatedVoiceAudioId={cell.selectedGeneratedVoiceAudioId}
          attachments={cell.attachments}
          projectId={projectId}
          fileId={cell.fileId}
        />
      )}

      <Button
        variant={hasAudio ? "ghost" : "outline"} size="sm" className="h-7 shrink-0"
        disabled={isBusy || batchRunning} onClick={onGenerate}
        title={hasAudio ? "Regenerate audio" : "Generate audio"}
      >
        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : hasAudio ? <RefreshCw className="h-3.5 w-3.5" />
          : <Volume2 className="h-3.5 w-3.5" />}
      </Button>

      <Button
        variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" onClick={onRecord}
        title={hasRecording ? "Re-record this line" : "Record a take for this line"}
      >
        <Mic className={cn("h-3.5 w-3.5", hasRecording && "text-emerald-600 dark:text-emerald-400")} />
      </Button>
    </div>
  )
}

/** The per-line speaker chip: shows the assigned cast member's color + name and
 *  opens a picker to reassign. Mirrors the cast colors used in the rail. */
function SpeakerChip({ voice, voices, onAssign }: {
  voice: Voice | undefined
  voices: Voice[]
  onAssign: (voiceId: string) => void
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            title="Assign a character to this line"
            className="flex max-w-[9rem] shrink-0 items-center gap-1.5 rounded-full border bg-background px-2 py-1 text-xs hover:bg-accent/50"
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ backgroundColor: voice?.color || "#94a3b8" }} />
            <span className="truncate">{voice?.name ?? "Unassigned"}</span>
            {voice?.referenceAudioId && <Sparkles className="h-2.5 w-2.5 shrink-0 text-violet-500" />}
          </button>
        }
      />
      <PopoverContent align="end" side="bottom" className="w-52 p-1">
        <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Assign character
        </p>
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {voices.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onAssign(v.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50",
                v.id === voice?.id && "bg-primary/10",
              )}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ backgroundColor: v.color || "#94a3b8" }} />
              <span className="flex-1 truncate">{v.name}</span>
              {v.referenceAudioId && <Sparkles className="h-3 w-3 shrink-0 text-violet-500" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Bottom bar shown while lines are multi-selected: assign them all to one
 *  character in a single action. */
function AssignBar({ count, voices, activeCastId, onAssign, onClear }: {
  count: number
  voices: Voice[]
  activeCastId: string | undefined
  onAssign: (voiceId: string) => void
  onClear: () => void
}) {
  const active = voices.find((v) => v.id === activeCastId)
  return (
    <div className="flex items-center gap-3 border-t bg-background px-4 py-2">
      <span className="text-sm font-medium tabular-nums">{count} selected</span>
      <span className="text-xs text-muted-foreground">Assign to</span>
      {active ? (
        <Button size="sm" className="h-8" onClick={() => onAssign(active.id)}>
          <span className="mr-1.5 h-2.5 w-2.5 rounded-full border" style={{ backgroundColor: active.color || "#94a3b8" }} />
          {active.name}
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground/70">pick a character →</span>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {voices.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => onAssign(v.id)}
            title={`Assign ${count} line(s) to ${v.name}`}
            className="flex items-center gap-1 rounded-full border bg-background px-2 py-1 text-xs hover:bg-accent/50"
          >
            <span className="h-2.5 w-2.5 rounded-full border" style={{ backgroundColor: v.color || "#94a3b8" }} />
            <span className="max-w-[7rem] truncate">{v.name}</span>
          </button>
        ))}
      </div>
      <div className="flex-1" />
      <Button variant="ghost" size="sm" className="h-8" onClick={onClear}>
        <X className="mr-1 h-3.5 w-3.5" /> Clear
      </Button>
    </div>
  )
}

/**
 * Surfaces a cell's failed-synth state. `generateCellVoice` writes errors to
 * the per-cell tts status map; without this the Generate button would just
 * spin and revert. The Gemini-key field lives in the rail (auto-opened when
 * absent), so the missing-key case needs no inline action here.
 */
function CellVoiceError({ cellId }: { cellId: string }) {
  const status = useTtsStatus(ttsStatusKey(cellId))
  if (status.kind !== "error") return null
  const error = categorizeAiError(status.message)
  const dismiss = () => setTtsStatus(ttsStatusKey(cellId), { kind: "idle" })
  return (
    <CellAiStatusPopover
      error={error}
      actions={[]}
      onDismiss={dismiss}
      trigger={
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive hover:bg-destructive/25"
        >
          <AlertCircle className="h-3 w-3" /> Failed
        </button>
      }
    />
  )
}
