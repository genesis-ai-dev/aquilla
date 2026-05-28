// Voice Studio — the single home for AI voice on a project (/project/:id/voice).
//
// Three zones: a left Voice Library rail (engine + key, voices, in-place
// editor, cloning), a top transport bar (read-along play-through + batch
// generate + a coverage meter + file switcher), and the production list — one
// row per cell with its assigned voice, generation status, play, and
// generate/regenerate. Drag a voice from the rail onto a row to assign it.
// Translation editing lives on the translate page; this is the audio view.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import {
  AlertCircle, ArrowLeft, CheckCircle2, Loader2, Mic, Pause, Play, RefreshCw,
  SkipBack, SkipForward, Sparkles, Square, Volume2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { getProject, patchProject } from "@/lib/store/project-index"
import { useProject } from "@/hooks/useProject"
import { useCells } from "@/hooks/useCells"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getVoiceLibrary, resolveVoice } from "@/lib/audio/voices"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { setTtsStatus, ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { categorizeAiError } from "@/lib/audio/ai-error"
import {
  hasAnyPlayableAudio, pauseQueue, resumeQueue, skipBack, skipForward,
  startQueue, stopQueue, updateQueueCells, useQueueState,
} from "@/lib/audio/play-queue"
import { CellTtsButton } from "./CellTtsButton"
import { CellAiStatusPopover } from "./CellAiStatusPopover"
import { EditorModeToggle } from "./EditorModeToggle"
import { VoiceLibraryPanel, VOICE_ASSIGN_MIME } from "./VoiceLibraryPanel"
import { VersionTag } from "./VersionBadge"
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
  // Per-row voice override (defaults to the project default).
  const [rowVoice, setRowVoice] = useState<Record<string, string>>({})
  // Booth-mode recording: when set, the AudioRecordingModal is open at this cell.
  const [recordCellId, setRecordCellId] = useState<string | null>(null)
  // TTS settings live in local IDB (engine, voices, API key). useProject reads
  // the server record, which doesn't include ttsSettings — so we hydrate the
  // local layer separately and overlay it onto the project for consumers.
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

  const voices = useMemo(() => getVoiceLibrary(project?.ttsSettings), [project?.ttsSettings])
  const defaultVoiceId = useMemo(
    () => resolveVoice(project?.ttsSettings, undefined).id,
    [project?.ttsSettings],
  )
  const voicesById = useMemo(() => {
    const m = new Map<string, Voice>()
    for (const v of voices) m.set(v.id, v)
    return m
  }, [voices])

  const saveTts = useCallback(
    async (overrides: Partial<ProjectTtsSettings>) => {
      if (!id) return
      // Optimistic local update so the engine toggle reflects the choice
      // immediately. patchProject persists to IDB; useProject's server-fetched
      // record doesn't carry ttsSettings, so refresh() would otherwise stomp
      // any local change.
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

  const generateOne = useCallback(
    async (cell: CellData) => {
      if (!project) return
      setBusy((s) => new Set(s).add(cell.id))
      const ok = await generateCellVoice({
        project, cell, session: session ?? null, username,
        voiceId: rowVoice[cell.id] ?? defaultVoiceId,
      })
      setBusy((s) => { const n = new Set(s); n.delete(cell.id); return n })
      if (ok) revalidate()
    },
    [project, session, username, rowVoice, defaultVoiceId, revalidate],
  )

  const generateAll = useCallback(async () => {
    if (!project || batchProgress) return
    const queue = generatableCells.filter((c) => !c.selectedGeneratedVoiceAudioId)
    if (queue.length === 0) return
    setBatchProgress({ done: 0, total: queue.length })
    for (let i = 0; i < queue.length; i++) {
      await generateCellVoice({
        project, cell: queue[i], session: session ?? null, username,
        voiceId: rowVoice[queue[i].id] ?? defaultVoiceId,
      })
      setBatchProgress({ done: i + 1, total: queue.length })
    }
    setBatchProgress(null)
    revalidate()
  }, [project, batchProgress, generatableCells, session, username, rowVoice, defaultVoiceId, revalidate])

  // ── Read-along playback ────────────────────────────────────────────────
  const queue = useQueueState()
  const playingCellId = queue.kind === "playing" || queue.kind === "loading" || queue.kind === "paused"
    ? queue.cellId
    : undefined
  const canPlay = hasAnyPlayableAudio(cells)

  // Keep the queue's cell snapshot fresh as audio gets generated mid-session.
  useEffect(() => { updateQueueCells(cells) }, [cells])
  // Stop playback when leaving the studio.
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

  if (loading) return <div className="p-8 text-muted-foreground">Loading…</div>
  if (!project || !id) return <div className="p-8 text-muted-foreground">Project not found.</div>

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
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
        {/* Left rail — voice library */}
        <aside className="flex w-[360px] shrink-0 flex-col border-r bg-muted/10">
          <div className="min-h-0 flex-1">
            <VoiceLibraryPanel
              settings={project.ttsSettings}
              onSettingsChange={saveTts}
              targetLanguage={project.targetLanguage}
              projectId={id}
              fileId={fileId}
              session={session ?? null}
            />
          </div>
          <VersionTag />
        </aside>

        {/* Right — transport + production list */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Transport bar */}
          <div className="flex items-center gap-3 border-b bg-background px-4 py-2">
            <div className="flex items-center gap-1">
              <Button
                variant="outline" size="icon" className="h-8 w-8"
                onClick={() => skipBack()}
                disabled={!canPlay || queue.kind === "idle"}
                title="Previous"
              >
                <SkipBack className="h-4 w-4" />
              </Button>
              <Button
                variant="default" size="icon" className="h-9 w-9"
                onClick={togglePlayAll}
                disabled={!canPlay}
                title={queue.kind === "playing" ? "Pause" : "Play through"}
              >
                {queue.kind === "loading" ? <Loader2 className="h-4 w-4 animate-spin" />
                  : queue.kind === "playing" ? <Pause className="h-4 w-4" />
                  : <Play className="h-4 w-4" />}
              </Button>
              <Button
                variant="outline" size="icon" className="h-8 w-8"
                onClick={() => skipForward()}
                disabled={!canPlay || queue.kind === "idle"}
                title="Next"
              >
                <SkipForward className="h-4 w-4" />
              </Button>
              {queue.kind !== "idle" && (
                <Button
                  variant="ghost" size="icon" className="h-8 w-8"
                  onClick={() => stopQueue()}
                  title="Stop"
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            {/* Coverage meter */}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${generatableCells.length ? (voicedCount / generatableCells.length) * 100 : 0}%` }}
                />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {voicedCount}/{generatableCells.length} voiced
              </span>
            </div>

            {project.files.length > 1 && (
              <select
                value={fileId ?? ""}
                onChange={(e) => { stopQueue(); setFileId(e.target.value) }}
                className="rounded border bg-background px-2 py-1 text-xs"
              >
                {project.files.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            )}

            <Button
              variant="outline" size="sm" className="h-8"
              onClick={() => { if (firstUnrecordedCellId) { stopQueue(); setRecordCellId(firstUnrecordedCellId) } }}
              disabled={!firstUnrecordedCellId || Boolean(batchProgress)}
              title="Record takes — booth mode (Space to start, ←/→ to navigate)"
            >
              <Mic className="mr-1 h-3.5 w-3.5" /> Record takes
              <span className="ml-1 tabular-nums opacity-70">
                ({recordedCount}/{generatableCells.length})
              </span>
            </Button>

            {batchProgress ? (
              <Button variant="outline" size="sm" disabled className="h-8">
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                <span className="tabular-nums">{batchProgress.done}/{batchProgress.total}</span>
              </Button>
            ) : (
              <Button
                variant="outline" size="sm" className="h-8"
                onClick={() => void generateAll()}
                disabled={pendingCount === 0}
              >
                <Sparkles className="mr-1 h-3.5 w-3.5" /> Generate all
                {pendingCount > 0 && <span className="ml-1 tabular-nums opacity-70">({pendingCount})</span>}
              </Button>
            )}
          </div>

          {/* Production list */}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {cellsLoading && cells.length === 0 ? (
              <div className="p-8 text-muted-foreground">Loading cells…</div>
            ) : generatableCells.length === 0 ? (
              <div className="p-8 text-muted-foreground">
                No translated cells in this file yet. Translate cells first, then generate their audio here.
              </div>
            ) : (
              <div className="space-y-1.5">
                {cells.map((cell) => {
                  const hasText = cell.type !== "paratext" && Boolean(cell.translated?.trim())
                  if (!hasText) return null
                  const hasAudio = Boolean(cell.selectedGeneratedVoiceAudioId)
                  const hasRecording = Boolean(cell.selectedAudioId)
                  const isBusy = busy.has(cell.id)
                  const selectedRowVoice = rowVoice[cell.id] ?? defaultVoiceId
                  const voice = voicesById.get(selectedRowVoice)
                  const isPlaying = cell.id === playingCellId
                  return (
                    <ProductionRow
                      key={cell.id}
                      cell={cell}
                      project={project}
                      projectId={id}
                      hasAudio={hasAudio}
                      hasRecording={hasRecording}
                      isBusy={isBusy}
                      batchRunning={Boolean(batchProgress)}
                      isPlaying={isPlaying}
                      voices={voices}
                      voice={voice}
                      selectedRowVoice={selectedRowVoice}
                      onAssignVoice={(vid) => setRowVoice((m) => ({ ...m, [cell.id]: vid }))}
                      onGenerate={() => void generateOne(cell)}
                      onRecord={() => { stopQueue(); setRecordCellId(cell.id) }}
                      session={session ?? null}
                    />
                  )
                })}
              </div>
            )}
          </div>
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
  hasAudio: boolean
  hasRecording: boolean
  isBusy: boolean
  batchRunning: boolean
  isPlaying: boolean
  voices: Voice[]
  voice: Voice | undefined
  selectedRowVoice: string
  onAssignVoice: (voiceId: string) => void
  onGenerate: () => void
  onRecord: () => void
  session: import("@/lib/frontier/types").FrontierSession | null
}

function ProductionRow({
  cell, project, projectId, hasAudio, hasRecording, isBusy, batchRunning, isPlaying,
  voices, voice, selectedRowVoice, onAssignVoice, onGenerate, onRecord,
}: RowProps) {
  const [dropActive, setDropActive] = useState(false)
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
        if (vid) { e.preventDefault(); onAssignVoice(vid) }
      }}
      className={cn(
        "flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors",
        isPlaying ? "border-primary/50 bg-primary/5"
          : dropActive ? "border-primary/60 bg-primary/10"
          : "border-transparent bg-muted/30 hover:bg-accent/30",
      )}
    >
      <span className="w-24 shrink-0 truncate text-xs text-muted-foreground" title={cell.cellLabel}>
        {cell.cellLabel ?? cell.id.slice(0, 8)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-sm leading-snug">{cell.translated?.trim()}</div>
      </div>

      {/* status */}
      <div className="w-20 shrink-0 text-right">
        {isError ? (
          <CellVoiceError cellId={cell.id} />
        ) : isLoading ? (
          <span className="inline-flex items-center gap-1 text-xs text-primary">
            <Loader2 className="h-3 w-3 animate-spin" /> Voicing
          </span>
        ) : hasAudio ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" /> Ready
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/60">No audio</span>
        )}
      </div>

      {/* voice chip / picker */}
      <div className="relative shrink-0">
        <span
          className="pointer-events-none absolute left-2 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border"
          style={{ backgroundColor: voice?.color || "#94a3b8" }}
        />
        <select
          value={selectedRowVoice}
          onChange={(e) => onAssignVoice(e.target.value)}
          className="max-w-[9rem] rounded-full border bg-background py-1 pl-6 pr-2 text-xs"
          title="Voice for this cell — or drag one from the library"
        >
          {voices.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
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
        variant={hasAudio ? "ghost" : "outline"}
        size="sm"
        className="h-7 shrink-0"
        disabled={isBusy || batchRunning}
        onClick={onGenerate}
      >
        {isBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          : hasAudio ? <RefreshCw className="mr-1 h-3.5 w-3.5" />
          : <Volume2 className="mr-1 h-3.5 w-3.5" />}
        {hasAudio ? "Regenerate" : "Generate"}
      </Button>

      <Button
        variant={hasRecording ? "ghost" : "outline"}
        size="sm"
        className="h-7 shrink-0"
        onClick={onRecord}
        title={hasRecording ? "Re-record this cell" : "Record a take for this cell"}
      >
        <Mic className={cn("mr-1 h-3.5 w-3.5", hasRecording && "text-emerald-600 dark:text-emerald-400")} />
        {hasRecording ? "Re-record" : "Record"}
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
