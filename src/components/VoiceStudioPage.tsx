// Voice Studio — the dedicated voice surface at /project/:id/voice.
//
// Per-file cell list with: which voice each cell will generate with, a play
// button for any already-generated audio (reusing CellTtsButton), per-cell
// generate/regenerate, and a batch "Generate all". The voices row sets the
// project default and previews clone references. Read-only on cells (no
// translation editing here) — this is the audio production view.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { AlertCircle, ArrowLeft, Loader2, RefreshCw, Sparkles, Star, Volume2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { getProject } from "@/lib/store/project-index"
import { patchProject } from "@/lib/store/project-index"
import { useCells } from "@/hooks/useCells"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { getVoiceLibrary, resolveVoice } from "@/lib/audio/voices"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { setTtsStatus, ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { openVoiceModalFromAnywhere } from "@/lib/audio/voice-actions"
import { CellTtsButton } from "./CellTtsButton"
import { CellAiStatusPopover } from "./CellAiStatusPopover"
import { VoiceController } from "./VoiceController"
import { EditorModeToggle } from "./EditorModeToggle"
import { ReferencePreview } from "./VoiceCloneSection"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings } from "@/lib/parsers/types"

/**
 * Surfaces a cell's failed-synth state in the studio. `generateCellVoice`
 * writes errors to the per-cell tts status map (the same key CellTtsButton
 * uses), but the studio's Generate button only spins and reverts — so without
 * this the failure was invisible until the cell happened to have audio. Mirrors
 * EditorTable's SynthStatusBadge so both editor modes report failures the same.
 */
function CellVoiceError({ cellId }: { cellId: string }) {
  const status = useTtsStatus(ttsStatusKey(cellId))
  if (status.kind !== "error") return null
  const error = categorizeAiError(status.message)
  const dismiss = () => setTtsStatus(ttsStatusKey(cellId), { kind: "idle" })
  const actions =
    error.category === "missing-gemini-key"
      ? [{ label: "Add Gemini API key", primary: true, onClick: () => openVoiceModalFromAnywhere("apiKey") }]
      : error.category === "translation-not-configured" ||
          error.category === "no-source-text" ||
          error.category === "git-project-unsupported" ||
          error.category === "sign-in-required"
        ? []
        : [{ label: "Open voice settings", onClick: () => openVoiceModalFromAnywhere() }]
  return (
    <CellAiStatusPopover
      error={error}
      actions={actions}
      onDismiss={dismiss}
      trigger={
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive hover:bg-destructive/25"
        >
          <AlertCircle className="h-3 w-3" /> Failed
        </button>
      }
    />
  )
}

export function VoiceStudioPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { session } = useFrontierSession()
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [fileId, setFileId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  // Per-cell voice override chosen in the studio (defaults to project default).
  const [rowVoice, setRowVoice] = useState<Record<string, string>>({})

  const refresh = useCallback(() => {
    if (!id) return
    void getProject(id).then((p) => { if (p) setProject(p) })
  }, [id])

  useEffect(() => {
    if (!id) return
    void getProject(id).then((p) => {
      if (p) {
        setProject(p)
        setFileId((cur) => cur ?? p.files[0]?.id ?? null)
      }
      setLoading(false)
    })
  }, [id])

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

  const saveTts = useCallback(
    async (overrides: Partial<ProjectTtsSettings>) => {
      if (!id) return
      await patchProject(id, (p) => ({ ...p, ttsSettings: { ...p.ttsSettings, ...overrides } }))
      refresh()
    },
    [id, refresh],
  )

  const generatableCells = useMemo(
    () => cells.filter((c) => c.type !== "paratext" && c.translated?.trim()),
    [cells],
  )

  const generateOne = useCallback(
    async (cell: CellData) => {
      if (!project) return
      setBusy((s) => new Set(s).add(cell.id))
      const ok = await generateCellVoice({
        project,
        cell,
        session: session ?? null,
        username,
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
        project,
        cell: queue[i],
        session: session ?? null,
        username,
        voiceId: rowVoice[queue[i].id] ?? defaultVoiceId,
      })
      setBatchProgress({ done: i + 1, total: queue.length })
    }
    setBatchProgress(null)
    revalidate()
  }, [project, batchProgress, generatableCells, session, username, rowVoice, defaultVoiceId, revalidate])

  if (loading) return <div className="p-8 text-muted-foreground">Loading…</div>
  if (!project || !id) return <div className="p-8 text-muted-foreground">Project not found.</div>

  const pendingCount = generatableCells.filter((c) => !c.selectedGeneratedVoiceAudioId).length

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

      {/* Voices row */}
      <div className="flex items-center gap-2 overflow-x-auto border-b bg-muted/30 px-4 py-2">
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
          Voices
        </span>
        {voices.map((voice) => {
          const isDefault = voice.id === defaultVoiceId
          return (
            <div
              key={voice.id}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                isDefault ? "border-primary/40 bg-primary/10" : "border-transparent bg-background",
              )}
            >
              <button
                type="button"
                onClick={() => void saveTts({ voices, defaultVoiceId: voice.id })}
                className="flex items-center gap-1.5"
                title={isDefault ? "Project default" : `Set ${voice.name} as default`}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full border"
                  style={{ backgroundColor: voice.color || "#94a3b8" }}
                />
                <span className="max-w-[10rem] truncate">{voice.name}</span>
                {voice.referenceAudioId && <Sparkles className="h-3 w-3 text-violet-500" />}
                {isDefault && <Star className="h-3 w-3 text-primary" />}
              </button>
              {voice.referenceAudioId && fileId && (
                <ReferencePreview
                  key={voice.referenceAudioId}
                  projectId={id}
                  fileId={fileId}
                  referenceAudioId={voice.referenceAudioId}
                  session={session ?? null}
                />
              )}
            </div>
          )
        })}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {project.files.length > 1 && (
            <select
              value={fileId ?? ""}
              onChange={(e) => setFileId(e.target.value)}
              className="rounded border bg-background px-2 py-1 text-xs"
            >
              {project.files.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          )}
          {batchProgress ? (
            <Button variant="outline" size="sm" disabled className="h-7">
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              <span className="tabular-nums">{batchProgress.done}/{batchProgress.total}</span>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void generateAll()}
              disabled={pendingCount === 0}
              className="h-7"
            >
              <Sparkles className="mr-1 h-3.5 w-3.5" /> Generate all
              {pendingCount > 0 && <span className="ml-1 tabular-nums opacity-70">({pendingCount})</span>}
            </Button>
          )}
        </div>
      </div>

      {/* Cell list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {cellsLoading && cells.length === 0 ? (
          <div className="p-8 text-muted-foreground">Loading cells…</div>
        ) : generatableCells.length === 0 ? (
          <div className="p-8 text-muted-foreground">
            No translated cells in this file yet. Translate cells first, then generate their audio here.
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <tbody>
              {cells.map((cell) => {
                const hasText = cell.type !== "paratext" && Boolean(cell.translated?.trim())
                const hasAudio = Boolean(cell.selectedGeneratedVoiceAudioId)
                const isBusy = busy.has(cell.id)
                const selectedVoiceId = rowVoice[cell.id] ?? defaultVoiceId
                return (
                  <tr key={cell.id} className="border-b last:border-0 hover:bg-accent/20">
                    <td className="w-28 px-4 py-2 align-top text-xs text-muted-foreground">
                      {cell.cellLabel ?? cell.id.slice(0, 8)}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <div className="line-clamp-2 leading-snug">
                        {cell.translated?.trim() || (
                          <span className="italic text-muted-foreground/60">not translated</span>
                        )}
                      </div>
                    </td>
                    {hasText && (
                      <td className="w-[28rem] px-2 py-2 align-top">
                        <div className="flex items-center justify-end gap-2">
                          <CellVoiceError cellId={cell.id} />
                          <select
                            value={selectedVoiceId}
                            onChange={(e) => setRowVoice((m) => ({ ...m, [cell.id]: e.target.value }))}
                            className="max-w-[10rem] rounded border bg-background px-2 py-1 text-xs"
                            title="Voice to generate this cell with"
                          >
                            {voices.map((v) => (
                              <option key={v.id} value={v.id}>{v.name}</option>
                            ))}
                          </select>
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
                              projectId={id}
                              fileId={cell.fileId}
                            />
                          )}
                          <Button
                            variant={hasAudio ? "ghost" : "outline"}
                            size="sm"
                            className="h-7"
                            disabled={isBusy || Boolean(batchProgress)}
                            onClick={() => void generateOne(cell)}
                          >
                            {isBusy ? (
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            ) : hasAudio ? (
                              <RefreshCw className="mr-1 h-3.5 w-3.5" />
                            ) : (
                              <Volume2 className="mr-1 h-3.5 w-3.5" />
                            )}
                            {hasAudio ? "Regenerate" : "Generate"}
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Hosts the VoiceModal and registers the imperative voice actions so the
          per-cell error popover's "Add Gemini API key" / "Open voice settings"
          links resolve here too (it's otherwise only mounted in the editor). */}
      <VoiceController
        project={project}
        activeFileId={fileId}
        cells={cells}
        username={username}
        session={session ?? null}
        onProjectChanged={() => { refresh(); revalidate() }}
      />
    </div>
  )
}
