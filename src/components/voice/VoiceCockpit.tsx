// Compact vertical voice control stack for the editor's left rail (w-64).
// A condensed sibling of VoiceTransportBar: active-profile chip, batch
// generate (selection-aware), play/pause through the shared play-queue,
// plus clone + record entry points. Wiring mirrors VoiceTransportBar so
// generation + playback behave identically; the host owns the library,
// clone, and recording flows via callbacks.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Copy, Loader2, Mic, Pause, Play, Sparkles, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { assignedCastVoiceId } from "@/lib/audio/voices"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import {
  hasAnyPlayableAudio, pauseQueue, resumeQueue, startQueue, stopQueue,
  updateQueueCells, useQueueState,
} from "@/lib/audio/play-queue"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord as Project, ProjectTtsSettings, Voice } from "@/lib/parsers/types"

interface VoiceCockpitProps {
  cells: CellData[]
  project: Project
  projectId: string
  settings: ProjectTtsSettings
  voices: Voice[]
  activeVoiceId: string
  selectedCellIds: string[]
  session: unknown
  username: string
  onAfterGenerate: () => void
  onAssignToSelection: (voiceId: string) => void
  onRequestClone: () => void
  onRecord: () => void
}

export function VoiceCockpit({
  cells, project, projectId, settings, voices, activeVoiceId, selectedCellIds,
  session, username, onAfterGenerate, onAssignToSelection, onRequestClone, onRecord,
}: VoiceCockpitProps) {
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const sess = session as FrontierSession | null

  const activeVoice = useMemo(
    () => voices.find((v) => v.id === activeVoiceId),
    [voices, activeVoiceId],
  )
  const selectedSet = useMemo(() => new Set(selectedCellIds), [selectedCellIds])
  const hasSelection = selectedCellIds.length > 0

  // ── Play-queue wiring (mirrors VoiceTransportBar) ──────────────────────────
  const queue = useQueueState()
  const canPlay = hasAnyPlayableAudio(cells)
  useEffect(() => { updateQueueCells(cells) }, [cells])
  useEffect(() => () => stopQueue(), [])

  const togglePlay = useCallback(() => {
    if (queue.kind === "playing") { pauseQueue(); return }
    if (queue.kind === "paused") { void resumeQueue(); return }
    if (!sess?.jwt) return
    const scoped = hasSelection ? cells.filter((c) => selectedSet.has(c.id)) : cells
    startQueue({ cells: scoped, projectId, session: sess }, 0)
  }, [queue.kind, sess, hasSelection, cells, selectedSet, projectId])

  // ── Batch generate (selection-aware) ───────────────────────────────────────
  const targets = useMemo(() => {
    const generatable = cells.filter((c) => c.type !== "paratext" && c.translated?.trim())
    if (hasSelection) return generatable.filter((c) => selectedSet.has(c.id))
    return generatable.filter((c) => !c.selectedGeneratedVoiceAudioId)
  }, [cells, hasSelection, selectedSet])

  const generate = useCallback(async () => {
    if (batch || targets.length === 0) return
    setBatch({ done: 0, total: targets.length })
    for (let i = 0; i < targets.length; i++) {
      const cell = targets[i]
      const voiceId = assignedCastVoiceId(settings, cell.id) ?? activeVoiceId
      const voice = voices.find((v) => v.id === voiceId)
      await generateCellVoice({
        project, cell, session: sess, username,
        voiceId: voice?.id ?? activeVoiceId,
      })
      setBatch({ done: i + 1, total: targets.length })
    }
    setBatch(null)
    onAfterGenerate()
  }, [batch, targets, settings, activeVoiceId, voices, project, sess, username, onAfterGenerate])

  const isPlaying = queue.kind === "playing"
  const isLoading = queue.kind === "loading"

  return (
    <div className="flex w-full flex-col gap-2 rounded-xl p-2 shadow-neu-xs neu-flat">
      {/* Active profile chip */}
      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 neu-inset">
        <span
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: activeVoice?.color ?? "#94a3b8" }}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={activeVoice?.name}>
          {activeVoice?.name ?? "No voice"}
        </span>
        {activeVoice?.referenceAudioId && (
          <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[10px] font-semibold text-primary">
            cloned
          </span>
        )}
      </div>

      {hasSelection && (
        <Button
          variant="outline" size="sm" className="h-8 justify-start"
          onClick={() => onAssignToSelection(activeVoiceId)} disabled={!activeVoice}
          title="Assign the active voice to the selected lines"
        >
          <Users className="mr-1.5 h-3.5 w-3.5" />
          Assign to {selectedCellIds.length}
        </Button>
      )}

      {/* Generate */}
      {batch ? (
        <Button variant="outline" size="sm" disabled className="h-8 justify-start">
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          <span className="tabular-nums">Generating {batch.done}/{batch.total}</span>
        </Button>
      ) : (
        <Button
          variant="default" size="sm" className="h-8 justify-start"
          onClick={() => void generate()} disabled={targets.length === 0}
        >
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          {hasSelection ? "Generate selected" : "Generate all"}
          {targets.length > 0 && (
            <span className="ml-1 tabular-nums opacity-80">({targets.length})</span>
          )}
        </Button>
      )}

      {/* Play / Pause */}
      <Button
        variant="outline" size="sm" className="h-8 justify-start"
        onClick={togglePlay} disabled={!canPlay}
        title={isPlaying ? "Pause" : hasSelection ? "Play selected" : "Play all"}
      >
        {isLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          : isPlaying ? <Pause className="mr-1.5 h-3.5 w-3.5" />
          : <Play className="mr-1.5 h-3.5 w-3.5" />}
        {isPlaying ? "Pause" : hasSelection ? "Play selected" : "Play all"}
      </Button>

      {/* Clone + Record */}
      <div className="flex gap-2">
        <Button
          variant="outline" size="sm" className="h-8 flex-1 justify-center"
          onClick={onRequestClone} title="Clone a voice from reference audio"
        >
          <Copy className="mr-1 h-3.5 w-3.5" /> Clone
        </Button>
        <Button
          variant="outline" size="sm" className="h-8 flex-1 justify-center"
          onClick={onRecord} title="Record takes in the booth"
        >
          <Mic className="mr-1 h-3.5 w-3.5" /> Record
        </Button>
      </div>
    </div>
  )
}
