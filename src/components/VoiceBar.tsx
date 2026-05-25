// The Speak bar: a slim toolbar above the editor for voice work. Lists the
// project's voices as draggable chips (drop one on a cell to generate + attach
// its audio), sets the project default voice on click, batch-generates audio
// for the whole file, and links into the voice library + Voice Studio.
//
// The imperative entry points (`VOICE_DRAG_MIME`, `openVoiceModalFromAnywhere`,
// `handleVoiceDropOnCell`) are re-exported from lib/audio/voice-actions so
// existing callers in EditorTable keep importing them from here.

import { useCallback, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Loader2, Mic2, Settings2, Sparkles, Star, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { getVoiceLibrary, resolveVoice } from "@/lib/audio/voices"
import { patchProject } from "@/lib/store/project-index"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import type { EditorTableHandle } from "./EditorTable"
import { VOICE_DRAG_MIME, openVoiceModalFromAnywhere } from "@/lib/audio/voice-actions"

interface Props {
  project: ProjectRecord
  cells: CellData[]
  username: string
  session: FrontierSession | null
  editorRef: React.RefObject<EditorTableHandle | null>
  onProjectChanged: () => void
  onCompleteSingle?: (cell: CellData) => Promise<void> | void
  onHide?: () => void
}

type BatchState =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number; cancel: () => void }

export function VoiceBar({ project, cells, username, session, onProjectChanged, onHide }: Props) {
  const navigate = useNavigate()
  const voices = useMemo(() => getVoiceLibrary(project.ttsSettings), [project.ttsSettings])
  const defaultVoiceId = useMemo(
    () => resolveVoice(project.ttsSettings, undefined).id,
    [project.ttsSettings],
  )
  const [batch, setBatch] = useState<BatchState>({ kind: "idle" })

  /** Persist a partial tts-settings change, then refresh the workspace. */
  const saveTts = useCallback(
    async (overrides: Partial<ProjectTtsSettings>) => {
      await patchProject(project.id, (p) => ({
        ...p,
        ttsSettings: { ...p.ttsSettings, ...overrides },
      }))
      onProjectChanged()
    },
    [project.id, onProjectChanged],
  )

  const setDefault = useCallback(
    (voiceId: string) => {
      // Persist the library too so the chosen id resolves even when the
      // project was still on the implicit preset list.
      void saveTts({ voices, defaultVoiceId: voiceId })
    },
    [saveTts, voices],
  )

  /** Cells that have target text — the candidates for batch generation. */
  const generatableCells = useMemo(
    () => cells.filter((c) => c.type !== "paratext" && c.translated?.trim()),
    [cells],
  )

  const generateAll = useCallback(() => {
    if (batch.kind === "running") return
    const queue = generatableCells.filter((c) => !c.selectedGeneratedVoiceAudioId)
    if (queue.length === 0) return
    let cancelled = false
    setBatch({ kind: "running", done: 0, total: queue.length, cancel: () => { cancelled = true } })
    void (async () => {
      let done = 0
      for (const cell of queue) {
        if (cancelled) break
        await generateCellVoice({ project, cell, session, username })
        done += 1
        setBatch((s) => (s.kind === "running" ? { ...s, done } : s))
      }
      setBatch({ kind: "idle" })
      onProjectChanged()
    })()
  }, [batch.kind, generatableCells, project, session, username, onProjectChanged])

  const pendingCount = generatableCells.filter((c) => !c.selectedGeneratedVoiceAudioId).length

  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b bg-muted/30 px-3 py-1.5">
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
        <Mic2 className="h-3.5 w-3.5" /> Voices
      </span>

      <div className="flex min-w-0 items-center gap-1.5">
        {voices.map((voice) => {
          const isDefault = voice.id === defaultVoiceId
          const isClone = Boolean(voice.referenceAudioId)
          return (
            <button
              key={voice.id}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(VOICE_DRAG_MIME, voice.id)
                e.dataTransfer.effectAllowed = "copy"
              }}
              onClick={() => setDefault(voice.id)}
              title={
                isDefault
                  ? `${voice.name} — project default. Drag onto a cell to generate.`
                  : `Set ${voice.name} as default. Drag onto a cell to generate.`
              }
              className={cn(
                "group flex shrink-0 cursor-grab items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors active:cursor-grabbing",
                isDefault
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-transparent bg-background hover:bg-accent/50",
              )}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full border"
                style={{ backgroundColor: voice.color || "#94a3b8" }}
              />
              <span className="max-w-[10rem] truncate">{voice.name}</span>
              {isClone && (
                <Sparkles className="h-3 w-3 shrink-0 text-violet-500" aria-label="Voice clone" />
              )}
              {isDefault && <Star className="h-3 w-3 shrink-0 text-primary" aria-label="Default" />}
            </button>
          )
        })}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {batch.kind === "running" ? (
          <Button variant="outline" size="sm" onClick={batch.cancel} className="h-7">
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            <span className="tabular-nums">{batch.done}/{batch.total}</span>
            <span className="ml-1">Stop</span>
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={generateAll}
            disabled={pendingCount === 0}
            className="h-7"
            title={
              pendingCount === 0
                ? "Every cell with text already has generated audio"
                : `Generate audio for ${pendingCount} cell(s) without it`
            }
          >
            <Sparkles className="mr-1 h-3.5 w-3.5" /> Generate all
            {pendingCount > 0 && <span className="ml-1 tabular-nums opacity-70">({pendingCount})</span>}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openVoiceModalFromAnywhere()}
          className="h-7"
          title="Manage voices"
        >
          <Settings2 className="mr-1 h-3.5 w-3.5" /> Voices
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/project/${project.id}/voice`)}
          className="h-7"
          title="Open the Voice Studio"
        >
          Studio
        </Button>
        {onHide && (
          <button
            type="button"
            onClick={onHide}
            title="Hide the voice bar"
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
