// Bottom detail pane for the selected timeline clip. Source (read, plus a play
// control when the clip's source is audio) and an editable target that reaches
// parity with the main cell editor by mounting the SHARED `TranslatedEditor`
// rather than a stripped-down textarea (AQU-659). Reusing the editor gives the
// media pane rich text, footnotes, terminology chips, and violation blots for
// free, and its commits persist identically to the main table.

import { cn } from "@/lib/utils"
import { fmtClock } from "./format"
import { TimelineSourceAudio } from "./TimelineSourceAudio"
import { TranslatedEditor } from "@/components/TranslatedEditor"
import type { CellData } from "@/hooks/useCells"
import type { Concept } from "@/lib/terminology/types"
import type { RuleInfraction } from "@/lib/parsers/types"
import type { ProjectRecord } from "@/lib/parsers/types"

export interface TimelineCellDetailProps {
  cell: CellData | null
  editable: boolean
  /** Emits a target commit. `valueHtml` carries the rich-text form so media
   *  edits persist identically to the main table (footnotes, marks, blots). */
  onCommitTarget(cellId: string, value: string, valueHtml?: string): void
  /** Needed to resolve/stream the clip's source audio. When absent (focused
   *  unit tests), the source-audio control is simply not mounted. */
  project?: ProjectRecord
  /** Active managed terminology concepts — drives the in-editor term chips. */
  terminologyConcepts?: Concept[]
  /** Rule infractions for the selected cell — drives the violation blots. */
  infractions?: RuleInfraction[]
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80">
      {children}
    </span>
  )
}

export function TimelineCellDetail({
  cell,
  editable,
  onCommitTarget,
  project,
  terminologyConcepts,
  infractions,
}: TimelineCellDetailProps) {
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

  const sourceAudio = cell.selectedAudioId ? cell.attachments?.[cell.selectedAudioId] : undefined
  const hasSourceAudio = Boolean(project && sourceAudio && !sourceAudio.isDeleted)

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
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            Source{isDialogue ? " · dialogue" : ""}
          </div>
          <div data-testid="tl-detail-source" className="text-sm leading-snug text-foreground">
            {cell.transcription || cell.original || "—"}
          </div>
          {hasSourceAudio && project && <TimelineSourceAudio project={project} cell={cell} />}
        </div>
        <div className="rounded-lg border border-border bg-card p-2.5">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            Target
          </div>
          <div
            data-testid="tl-detail-target"
            className={cn(
              "rounded-md border border-border bg-background px-2 py-1 text-sm focus-within:ring-2 focus-within:ring-sky-500/40",
              !editable && "opacity-60",
            )}
          >
            <TranslatedEditor
              cellId={cell.id}
              initialPlain={cell.translated ?? ""}
              initialHtml={cell.translatedHtml}
              editable={editable}
              compactHeight
              placeholder={editable ? "Translation…" : ""}
              ariaLabel="Clip translation"
              terminologyConcepts={terminologyConcepts}
              infractions={infractions}
              onCommit={(snapshot) => {
                if (editable) onCommitTarget(cell.id, snapshot.value, snapshot.valueHtml)
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
