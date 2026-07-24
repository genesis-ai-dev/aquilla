// Bottom detail pane for the selected timeline clip. A focused surface — source
// (read), an editable target that commits on blur, plus speaker/camera/timecode
// metadata. Deliberately NOT the full editor row: that component takes ~40 props
// and reusing it would couple the timeline to the entire editor. Same intent
// (read + edit a clip from the timeline) with a fraction of the surface.

import { useEffect, useState } from "react"
import { Loader2, Mic } from "lucide-react"
import { cn } from "@/lib/utils"
import { fmtClock } from "./format"
import { useTranscribeStatus } from "@/lib/audio/transcribe-status"
import type { CellData } from "@/hooks/useCells"

export interface TimelineCellDetailProps {
  cell: CellData | null
  editable: boolean
  onCommitTarget(cellId: string, value: string): void
  /** AQU-646: transcribe this clip's audio into source text (media segments).
   *  When absent the Transcribe affordance is hidden (read-only surfaces). */
  onTranscribe?(cell: CellData): void
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80">
      {children}
    </span>
  )
}

export function TimelineCellDetail({ cell, editable, onCommitTarget, onTranscribe }: TimelineCellDetailProps) {
  const [draft, setDraft] = useState("")
  const transcribeStatus = useTranscribeStatus(cell?.selectedAudioId)
  useEffect(() => {
    setDraft(cell?.translated ?? "")
  }, [cell?.id, cell?.translated])

  if (!cell) {
    return (
      <div
        data-testid="tl-detail-empty"
        className="flex items-center justify-center border-t border-border bg-muted/20 px-4 py-6 text-sm text-muted-foreground"
      >
        Select a clip to see and edit its details.
      </div>
    )
  }

  const isDialogue = (cell.medium ?? "text") === "media"
  const start = cell.startTime ?? 0
  const end = cell.endTime ?? start
  const castName =
    cell.metadata && typeof cell.metadata.cast_name === "string"
      ? (cell.metadata.cast_name as string)
      : null

  return (
    <div data-testid="tl-detail" className="border-t border-border bg-muted/20 px-4 py-3">
      <div className="mb-2.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Pill>
          <b className="font-semibold text-foreground">{isDialogue ? "Dialogue" : "Subtitle"}</b>
        </Pill>
        <Pill>
          <span className="font-mono tabular-nums">
            {fmtClock(start, true)}–{fmtClock(end, true)}
          </span>
        </Pill>
        {castName && (
          <Pill>
            Speaker <b className="font-semibold text-foreground">{castName}</b>
          </Pill>
        )}
        {isDialogue && cell.cameraState && (
          <Pill>
            Camera <b className="font-semibold text-foreground">{cell.cameraState}</b>
          </Pill>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              Source{isDialogue ? " · dialogue" : ""}
            </span>
            {/* AQU-646: transcribe the clip's audio into source text right
                where the clip is being worked on. Media segments only. */}
            {onTranscribe && isDialogue && cell.selectedAudioId && (
              <button
                type="button"
                data-testid="tl-detail-transcribe"
                onClick={() => onTranscribe(cell)}
                disabled={
                  !editable ||
                  transcribeStatus.kind === "loading" ||
                  transcribeStatus.kind === "transcribing"
                }
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-foreground/80 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {transcribeStatus.kind === "loading" || transcribeStatus.kind === "transcribing" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Transcribing…
                  </>
                ) : (
                  <>
                    <Mic className="h-3 w-3" /> {cell.transcription ? "Re-transcribe" : "Transcribe"}
                  </>
                )}
              </button>
            )}
          </div>
          <div data-testid="tl-detail-source" className="text-sm leading-snug text-foreground">
            {cell.transcription || cell.original || "—"}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-2.5">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            Target
          </div>
          <textarea
            data-testid="tl-detail-target"
            value={draft}
            disabled={!editable}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (editable && draft !== (cell.translated ?? "")) onCommitTarget(cell.id, draft)
            }}
            rows={2}
            className={cn(
              "w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none",
              "focus:ring-2 focus:ring-sky-500/40 disabled:cursor-not-allowed disabled:opacity-60",
            )}
            placeholder={editable ? "Translation…" : ""}
          />
        </div>
      </div>
    </div>
  )
}
