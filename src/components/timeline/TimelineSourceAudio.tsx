// Source-audio play control for the timeline clip detail pane (AQU-659).
//
// A media clip's source is a recording attachment (slot "recording"), attached
// by the importer / diarization / attach-media path. The detail pane used to
// show only the mp3 filename as text with no way to hear it. This surfaces a
// real play/pause control by reusing the same `useCellAudio` controller the
// main editor row uses — no bespoke audio element lifecycle here.
//
// Mounted by TimelineCellDetail ONLY when the clip actually has a recording
// attachment, so `useCellAudio` (which pulls the frontier session via
// react-query) never runs for audio-less clips or in provider-less unit tests.

import { useMemo } from "react"
import { AlertCircle, Pause, Play } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { useCellAudio } from "@/hooks/useCellAudio"
import type { CellData } from "@/hooks/useCells"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { fmtClock } from "./format"
import { AppTooltip } from "@/components/ui/tooltip"

export interface TimelineSourceAudioProps {
  project: ProjectRecord
  cell: CellData
}

export function TimelineSourceAudio({ project, cell }: TimelineSourceAudioProps) {
  // Minimal CodexCell shape for the audio hook — useCellAudio only reads
  // metadata.selectedAudioId and metadata.attachments[selectedAudioId]
  // (mirrors EditorTable's cellForAudio construction).
  const cellForAudio = useMemo(
    () =>
      ({
        metadata: {
          attachments: cell.attachments,
          selectedAudioId: cell.selectedAudioId,
        },
      }) as unknown as CodexCell,
    [cell.attachments, cell.selectedAudioId],
  )
  const audio = useCellAudio(project, cellForAudio, cell.fileId)

  const busy = audio.state === "loading"
  const isError = audio.state === "error"
  const label = audio.isPlaying ? "Pause source audio" : "Play source audio"

  return (
    <div data-testid="tl-detail-source-audio" className="mt-2 flex items-center gap-2">
      <AppTooltip content={label}>
        <button
          type="button"
          aria-label={label}
          disabled={isError}
          onClick={() => (audio.isPlaying ? audio.pause() : void audio.play())}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground/80 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Spinner className="size-3.5" />
          ) : isError ? (
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          ) : audio.isPlaying ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
        </button>
      </AppTooltip>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {fmtClock(audio.currentTime, true)}
        {audio.duration ? ` / ${fmtClock(audio.duration, true)}` : ""}
      </span>
      {isError && (
        <span className="text-[11px] text-destructive">
          {audio.error?.message ?? "Source audio unavailable"}
        </span>
      )}
    </div>
  )
}
