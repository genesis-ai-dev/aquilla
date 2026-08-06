/**
 * ChatContextPin.tsx — chat UX improvements
 *
 * Shared cell-context toggle strip for the chat sheet and dock panels.
 * `compact` selects the dock's tighter sizing.
 */

import { FolderOpen, Pin, PinOff } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { cellTextForDisplay, truncateCellText } from "@/lib/cell-text"
import type { CellContext } from "@/lib/cell-context"

export interface ChatContextPinProps {
  includeCellContext: boolean
  onToggle: (v: boolean) => void
  currentCell: CellContext | null
  compact?: boolean
  /** Open file's name — shown when no cell is focused so the pill is honest
   *  about file-level context still being sent (agent dock). */
  fileName?: string
  /** Workbench mode: this control chooses focus instead of toggling context. */
  onChooseContext?: () => void
  /** Render only the control, without the dock's full-width context strip. */
  bare?: boolean
}

export function ChatContextPin({
  includeCellContext,
  onToggle,
  currentCell,
  compact,
  fileName,
  onChooseContext,
  bare = false,
}: ChatContextPinProps) {
  const preview =
    includeCellContext && currentCell
      ? cellTextForDisplay(currentCell.sourceText) || cellTextForDisplay(currentCell.translatedText)
      : ""

  return (
    <div
      className={cn(
        "flex items-center",
        bare ? "" : "gap-2 border-b bg-muted/40",
        !bare && (compact ? "px-3 py-1.5" : "px-4 py-2"),
      )}
    >
      <AppTooltip
        content={
          onChooseContext
            ? "Choose the file the agent works with"
            : includeCellContext
            ? "Cell context is included; click to exclude"
            : "Click to include the current cell as context"
        }
      >
        <button
          type="button"
          onClick={() => onChooseContext ? onChooseContext() : onToggle(!includeCellContext)}
          aria-label={onChooseContext ? (fileName ? "Change agent file" : "Choose agent file") : undefined}
          className={cn(
            "flex items-center gap-1.5 rounded-md transition-colors",
            compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]",
            onChooseContext && bare
              ? "text-muted-foreground hover:bg-muted hover:text-foreground"
              : onChooseContext
              ? "bg-background text-foreground shadow-xs hover:bg-accent"
              : includeCellContext && currentCell
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent",
          )}
        >
          {onChooseContext ? (
            <FolderOpen className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
          ) : includeCellContext ? (
            <Pin className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
          ) : (
            <PinOff className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
          )}
          {onChooseContext
            ? fileName ? "Change file" : "Choose a file"
            : includeCellContext && currentCell
            ? currentCell.context
              ? `Cell: ${currentCell.context}`
              : "Cell context on"
            : includeCellContext && fileName
              ? `File: ${fileName}`
              : "No cell context"}
        </button>
      </AppTooltip>
      {preview && (
        <AppTooltip content={preview}>
          <span className={cn("truncate text-muted-foreground", compact ? "text-[10px]" : "text-[11px]")}>
            {truncateCellText(preview, compact ? 30 : 40)}
          </span>
        </AppTooltip>
      )}
    </div>
  )
}
