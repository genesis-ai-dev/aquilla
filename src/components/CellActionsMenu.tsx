// Ellipsis popover for per-cell actions that don't warrant a permanent icon.
// Follows the "visible is better than hidden" rule by keeping frequently-used
// actions (comments, play/mic, validation) in the gutter and only burying
// contextual/infrequent ones (re-record, history, regenerate backtranslation).

import { useState } from "react"
import { MoreHorizontal, Mic, History as HistoryIcon, Languages, Sparkles, Wand2, MessageCircle } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { CellData } from "@/hooks/useCells"
import type { CellAuditStats } from "@/hooks/useCellsAuditStats"

interface Props {
  cell: CellData
  editable: boolean
  hasAudio: boolean
  isGitProject: boolean
  isBacktranslationConfigured?: boolean
  isBacktranslating?: boolean
  isTranscribing?: boolean
  isSynthesizing?: boolean
  onOpenRecording?: (cellId: string) => void
  onOpenHistory?: (cellId: string) => void
  onBacktranslate?: (cell: CellData) => void
  onTranscribe?: (cell: CellData) => void
  onSynthesizeAudio?: (cell: CellData) => void
  /** Called when the user chooses "Add comment" from the menu. */
  onAddComment?: (cellId: string) => void
  /** D1-backed per-cell audit stats for this file. When provided, editCount is
   *  preferred over cell.history.length for the history count badge. */
  auditStatsByCellId?: Map<string, CellAuditStats>
}

export function CellActionsMenu({
  cell, editable, hasAudio, isGitProject,
  isBacktranslationConfigured, isBacktranslating, isTranscribing, isSynthesizing,
  onOpenRecording, onOpenHistory, onBacktranslate, onTranscribe, onSynthesizeAudio,
  onAddComment,
  auditStatsByCellId,
}: Props) {
  const [open, setOpen] = useState(false)

  // Prefer D1 editCount when available; fall back to Y.Doc history length.
  const d1Stats = auditStatsByCellId?.get(cell.id)
  const historyCount = d1Stats?.editCount ?? cell.history.length

  const items: Array<
    | { key: string; icon: React.ReactNode; label: string; disabled?: boolean; onSelect: () => void }
    | null
  > = [
    onAddComment
      ? {
          key: "addcomment",
          icon: <MessageCircle className="h-3.5 w-3.5" />,
          label: "Add comment",
          onSelect: () => { onAddComment(cell.id); setOpen(false) },
        }
      : null,
    hasAudio && onOpenRecording
      ? {
          key: "rerecord",
          icon: <Mic className="h-3.5 w-3.5" />,
          label: "Re-record audio",
          disabled: !editable || isGitProject,
          onSelect: () => { onOpenRecording(cell.id); setOpen(false) },
        }
      : null,
    hasAudio && onTranscribe
      ? {
          key: "transcribe",
          icon: <Sparkles className={cn("h-3.5 w-3.5", isTranscribing && "animate-pulse")} />,
          label: isTranscribing ? "Transcribing…" : "Transcribe with Whisper",
          disabled: !editable || Boolean(isTranscribing),
          onSelect: () => { onTranscribe(cell); setOpen(false) },
        }
      : null,
    onSynthesizeAudio && cell.translated.trim().length > 0 && !isGitProject
      ? {
          key: "synth",
          icon: <Wand2 className={cn("h-3.5 w-3.5", isSynthesizing && "animate-pulse")} />,
          label: isSynthesizing
            ? "Synthesizing…"
            : hasAudio ? "Generate AI voice (replaces audio)" : "Generate AI voice",
          disabled: !editable || Boolean(isSynthesizing),
          onSelect: () => { onSynthesizeAudio(cell); setOpen(false) },
        }
      : null,
    onOpenHistory && historyCount > 0
      ? {
          key: "history",
          icon: <HistoryIcon className="h-3.5 w-3.5" />,
          label: `History (${historyCount})`,
          onSelect: () => { onOpenHistory(cell.id); setOpen(false) },
        }
      : null,
    isBacktranslationConfigured !== undefined && onBacktranslate
      ? {
          key: "backtranslate",
          icon: <Languages className={cn("h-3.5 w-3.5", isBacktranslating && "animate-pulse")} />,
          label: cell.backtranslation ? "Regenerate backtranslation" : "Generate backtranslation",
          disabled: !isBacktranslationConfigured || isBacktranslating || !editable,
          onSelect: () => { onBacktranslate(cell); setOpen(false) },
        }
      : null,
  ]

  const visibleItems = items.filter((x): x is NonNullable<typeof x> => x !== null)
  if (visibleItems.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="More actions"
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-lg transition-[transform,color] duration-150 ease-out active:scale-[0.92] hover:bg-muted/60",
              open ? "text-foreground bg-muted/60" : "text-muted-foreground/50 hover:text-foreground",
            )}
          >
            <MoreHorizontal className="h-3 w-3" />
          </button>
        }
      />
      <PopoverContent side="left" align="start" className="min-w-[180px] rounded-xl p-1">
        <ul role="menu" className="flex flex-col">
          {visibleItems.map((item) => (
            <li key={item.key} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={item.onSelect}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                  "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                )}
              >
                <span className="text-muted-foreground">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
