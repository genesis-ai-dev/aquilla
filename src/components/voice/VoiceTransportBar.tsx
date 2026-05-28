// The Audio-lens transport strip: play the file through, see voicing coverage,
// jump into booth recording, and batch-generate every unvoiced line. Lifted
// from the old Voice Studio's transport so the editor's Audio lens behaves
// identically. Owns the play-queue + batch-generate state internally; the host
// only supplies data + a couple of callbacks.

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Loader2, Mic, Pause, Play, SkipBack, SkipForward, Sparkles, Square,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { resolveCastVoice } from "@/lib/audio/voices"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import {
  hasAnyPlayableAudio, pauseQueue, resumeQueue, skipBack, skipForward,
  startQueue, stopQueue, updateQueueCells, useQueueState,
} from "@/lib/audio/play-queue"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord, ProjectTtsSettings } from "@/lib/parsers/types"

interface Props {
  cells: CellData[]
  project: ProjectRecord
  projectId: string
  /** Hydrated TTS settings (cast assignments) so generated voices match the cast. */
  settings: ProjectTtsSettings | undefined
  session: FrontierSession | null
  username: string
  /** Revalidate cells after generation so new audio shows up. */
  onAfterGenerate: () => void
  /** Open the booth recorder at a cell. */
  onRecord: (cellId: string) => void
  /** Bring a cell into view as play-through advances. */
  onCellPlaying?: (cellId: string) => void
}

export function VoiceTransportBar({
  cells, project, projectId, settings, session, username,
  onAfterGenerate, onRecord, onCellPlaying,
}: Props) {
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)

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
  const coveragePct = generatableCells.length ? (voicedCount / generatableCells.length) * 100 : 0

  // ── Read-along playback ───────────────────────────────────────────────────
  const queue = useQueueState()
  const canPlay = hasAnyPlayableAudio(cells)
  useEffect(() => { updateQueueCells(cells) }, [cells])
  useEffect(() => () => stopQueue(), [])

  const togglePlayAll = useCallback(() => {
    if (queue.kind === "playing") { pauseQueue(); return }
    if (queue.kind === "paused") { void resumeQueue(); return }
    if (!session?.jwt) return
    startQueue(
      { cells, projectId, session, onCellChange: (_i, cid) => onCellPlaying?.(cid) },
      0,
    )
  }, [queue.kind, projectId, session, cells, onCellPlaying])

  // ── Batch generate ────────────────────────────────────────────────────────
  const generateAll = useCallback(async () => {
    if (batchProgress) return
    const queueCells = generatableCells.filter((c) => !c.selectedGeneratedVoiceAudioId)
    if (queueCells.length === 0) return
    setBatchProgress({ done: 0, total: queueCells.length })
    for (let i = 0; i < queueCells.length; i++) {
      await generateCellVoice({
        project, cell: queueCells[i], session, username,
        voiceId: resolveCastVoice(settings, queueCells[i].id, queueCells[i].ttsSettings?.voiceId).id,
      })
      setBatchProgress({ done: i + 1, total: queueCells.length })
    }
    setBatchProgress(null)
    onAfterGenerate()
  }, [batchProgress, generatableCells, project, settings, session, username, onAfterGenerate])

  return (
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

      <Button
        variant="outline" size="sm" className="h-8"
        onClick={() => { if (firstUnrecordedCellId) { stopQueue(); onRecord(firstUnrecordedCellId) } }}
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
  )
}
