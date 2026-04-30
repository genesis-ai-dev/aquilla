// Top-of-file toolbar for everything voice-related: a single play queue
// (walks cells from the first visible one), a draggable voice inventory,
// and the entry point to edit voices. Draws audio out of the cell rows so
// the cell UI can focus on text + recording.

import { useCallback, useMemo, useState } from "react"
import {
  ChevronsLeft, ChevronsRight, Loader2, Pause, Play, Settings2, Square,
} from "lucide-react"
import * as Y from "yjs"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, Voice } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { EditorTableHandle } from "./EditorTable"
import { VoiceModal } from "./VoiceModal"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  hasAnyPlayableAudio, pauseQueue, resumeQueue, skipBack, skipForward,
  startQueue, stopQueue, useQueueState,
} from "@/lib/audio/play-queue"
import { getVoiceLibrary } from "@/lib/audio/voices"
import { setCellTtsSettings } from "@/lib/audio/cell-tts-settings"
import { synthAndAttachAudio } from "@/lib/audio/synth-and-attach"
import { setTtsStatus } from "@/lib/audio/tts"
import { AiModelConsentDeniedError } from "@/lib/audio/ai-consent"
import { patchProject } from "@/lib/store/project-index"

/** DataTransfer key used by voice chips → cell drop targets. */
export const VOICE_DRAG_MIME = "application/x-frontier-voice-id"

interface Props {
  project: ProjectRecord
  cells: CellData[]
  doc: Y.Doc
  username: string
  session: FrontierSession | null
  editorRef: React.RefObject<EditorTableHandle | null>
  onProjectChanged: () => void
}

export function VoiceBar({
  project, cells, doc, username, session, editorRef, onProjectChanged,
}: Props) {
  const [modalOpen, setModalOpen] = useState(false)
  const queue = useQueueState()
  const voices = getVoiceLibrary(project.ttsSettings)
  const isGitProject = project.origin?.kind === "git"

  const playable = useMemo(() => hasAnyPlayableAudio(cells), [cells])

  const saveProjectTtsSettings = useCallback(async (overrides: Partial<import("@/lib/parsers/types").ProjectTtsSettings>) => {
    await patchProject(project.id, (latest) => {
      const base = latest.ttsSettings
      return {
        ...latest,
        ttsSettings: {
          provider: overrides.provider ?? base?.provider,
          apiKey: Object.prototype.hasOwnProperty.call(overrides, "apiKey") ? overrides.apiKey : base?.apiKey,
          voices: overrides.voices ?? base?.voices,
          defaultVoiceId: Object.prototype.hasOwnProperty.call(overrides, "defaultVoiceId") ? overrides.defaultVoiceId : base?.defaultVoiceId,
        },
      }
    })
    onProjectChanged()
  }, [project.id, onProjectChanged])

  const startPlayback = useCallback(() => {
    if (!session) return
    const startIdx = editorRef.current?.getCurrentIndex?.() ?? 0
    startQueue({
      cells,
      projectId: project.id,
      session,
      onCellChange: (index) => editorRef.current?.scrollToCellIndex(index),
    }, startIdx)
  }, [cells, editorRef, project.id, session])

  const onPlayClick = () => {
    if (queue.kind === "playing") {
      pauseQueue()
    } else if (queue.kind === "paused") {
      void resumeQueue()
    } else {
      startPlayback()
    }
  }

  const isPlayingOrLoading = queue.kind === "playing" || queue.kind === "loading"
  const isLoading = queue.kind === "loading"

  // ── Generate via drop ─────────────────────────────────────────────────────
  // Public API exposed via context-like prop drilling: the EditorRow listens
  // for VOICE_DRAG_MIME drops and calls onVoiceDrop with the cellId + voiceId.
  // We generate via the same path the per-cell button used to take.

  return (
    <div className="flex items-center gap-3 border-b bg-background/95 px-4 py-1.5 text-xs backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={skipBack}
          disabled={!playable || queue.kind === "idle"}
          aria-label="Previous cell with audio"
          title="Previous"
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant={isPlayingOrLoading ? "default" : "ghost"}
          onClick={onPlayClick}
          disabled={!playable || !session}
          aria-label={isPlayingOrLoading ? "Pause" : "Play from first visible cell"}
          title={
            !session ? "Sign in to play audio" :
            !playable ? "No audio yet — generate or record some first" :
            isPlayingOrLoading ? "Pause" :
            queue.kind === "paused" ? "Resume" :
            "Play from first visible cell"
          }
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> :
           isPlayingOrLoading ? <Pause className="h-4 w-4" /> :
           <Play className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={skipForward}
          disabled={!playable || queue.kind === "idle"}
          aria-label="Next cell with audio"
          title="Next"
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>
        {(queue.kind === "playing" || queue.kind === "paused" || queue.kind === "loading") && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={stopQueue}
            aria-label="Stop"
            title="Stop"
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="h-5 w-px bg-border" />

      <div className="flex items-center gap-1.5 overflow-x-auto">
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
          Voices
        </span>
        {voices.map((voice) => (
          <VoiceChip key={voice.id} voice={voice} />
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0 gap-1 text-xs"
          onClick={() => setModalOpen(true)}
          title="Edit voice library"
        >
          <Settings2 className="h-3.5 w-3.5" />
          Edit voices
        </Button>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {queue.kind === "error" && (
          <span className="text-[11px] text-destructive">{queue.message}</span>
        )}
        {(queue.kind === "playing" || queue.kind === "paused" || queue.kind === "loading") && (
          <span className="text-[11px] text-muted-foreground">
            Cell {queue.cellIndex + 1}
          </span>
        )}
        {!isGitProject && (
          <span className="hidden sm:inline text-[11px] text-muted-foreground">
            Drag a voice onto a cell to generate
          </span>
        )}
      </div>

      <VoiceModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        targetLanguage={project.targetLanguage}
        settings={project.ttsSettings}
        onSettingsChange={saveProjectTtsSettings}
      />

      {/* Hidden helper to expose the generate-on-drop entry point to cells. */}
      <DropGenerator
        project={project}
        cells={cells}
        doc={doc}
        username={username}
        session={session}
      />
    </div>
  )
}

// ── Voice chip ─────────────────────────────────────────────────────────────

function VoiceChip({ voice }: { voice: Voice }) {
  const onDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.setData(VOICE_DRAG_MIME, voice.id)
    e.dataTransfer.effectAllowed = "copy"
  }
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      title={`Drag onto a cell to generate with ${voice.name}`}
      className={cn(
        "shrink-0 inline-flex cursor-grab items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-[11px] font-medium",
        "hover:bg-accent active:cursor-grabbing active:scale-[0.97]",
      )}
    >
      <span
        className="h-2 w-2 rounded-full border"
        style={{ backgroundColor: voice.color || "#94a3b8" }}
        aria-hidden
      />
      <span>{voice.name}</span>
    </button>
  )
}

// ── Drop → generate registration ───────────────────────────────────────────
// We register a global handler keyed by cellId so the row's drop handler can
// fire it without re-plumbing all the dependencies the synth path needs.

interface DropContext {
  project: ProjectRecord
  doc: Y.Doc
  username: string
  session: FrontierSession | null
}

let dropCtx: DropContext | null = null
let cellsByIdRef: Map<string, CellData> | null = null

function DropGenerator({ project, cells, doc, username, session }: {
  project: ProjectRecord
  cells: CellData[]
  doc: Y.Doc
  username: string
  session: FrontierSession | null
}) {
  // Refresh the static refs each render so the drop handler sees current data.
  dropCtx = { project, doc, username, session }
  cellsByIdRef = new Map(cells.map((c) => [c.id, c]))
  return null
}

/**
 * Trigger generation for a cell using the dropped voice id. Called by the
 * EditorRow's drop handler. Wires status into the per-cell synth status
 * registry so the existing badges/spinners light up.
 */
export async function handleVoiceDropOnCell(cellId: string, voiceId: string): Promise<void> {
  const ctx = dropCtx
  const cell = cellsByIdRef?.get(cellId)
  if (!ctx || !cell) return
  if (!ctx.session?.jwt) {
    setTtsStatus(`synth:${cellId}`, { kind: "error", message: "Sign in to upload audio" })
    return
  }
  if (ctx.project.origin?.kind === "git") {
    setTtsStatus(`synth:${cellId}`, { kind: "error", message: "AI voice not supported on git projects yet" })
    return
  }
  if (!cell.translated.trim()) return

  // Persist the chosen voice on the cell so subsequent bulk-generate /
  // re-synth actions reuse it.
  setCellTtsSettings(ctx.doc, cellId, { voiceId })

  const statusKey = `synth:${cellId}`
  setTtsStatus(statusKey, { kind: "loading", loaded: 0, total: 0, file: "" })
  try {
    await synthAndAttachAudio({
      doc: ctx.doc,
      cellId,
      cellText: cell.translated,
      cellOriginal: cell.original,
      cellContext: cell.context,
      cellLabel: cell.cellLabel,
      projectId: ctx.project.id,
      sourceLanguage: ctx.project.sourceLanguage,
      languageTag: ctx.project.targetLanguage,
      session: ctx.session,
      username: ctx.username,
      projectTtsSettings: ctx.project.ttsSettings,
      cellVoiceId: voiceId,
      onTtsProgress: (p) => {
        setTtsStatus(statusKey, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
        if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
          setTtsStatus(statusKey, { kind: "synthesizing" })
        }
      },
    })
    setTtsStatus(statusKey, { kind: "idle" })
  } catch (e) {
    if (e instanceof AiModelConsentDeniedError) {
      setTtsStatus(statusKey, { kind: "idle" })
      return
    }
    setTtsStatus(statusKey, {
      kind: "error",
      message: e instanceof Error ? e.message : String(e),
    })
  }
}
