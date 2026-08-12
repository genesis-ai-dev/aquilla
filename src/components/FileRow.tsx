import { useEffect, useRef, useState } from "react"
import { ChevronRight, MoreHorizontal, Sparkles, AudioWaveform } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { fileHasSections, fileOrderedBy } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { FileActionMenu } from "./FileActionMenu"
import { useT } from "@/lib/i18n/I18nProvider"

interface FileStats { translated: number; validated: number; total: number }

interface FileRowProps {
  file: FileReference
  active: boolean
  expanded: boolean
  progress?: FileStats
  openCommentCount?: number
  hasSuggestion?: boolean
  editing: boolean
  onEditCommit: (newName: string) => void
  onEditCancel: () => void
  onToggleExpand: () => void
  onSelect: () => void
  /** Opens the FileDetailsModal for this file. */
  onShowDetails?: () => void
  onStartRename: () => void
  onMove: () => void
  /** AQU-271: Optional — pass undefined to hide delete for roles below project_lead. */
  onDelete?: () => void
  onExportSource?: () => void
  onApplySuggestion?: () => void
}

/** Open the parent ContextMenu at the pointer (used by the ⋯ button). */
function openContextMenuAtPointer(target: EventTarget & Element, clientX: number, clientY: number) {
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 2,
    }),
  )
}

export function FileRow(props: FileRowProps) {
  const {
    file, active, expanded, progress, hasSuggestion, editing,
    onEditCommit, onEditCancel, onToggleExpand, onSelect, onShowDetails, onStartRename,
    onMove, onDelete, onExportSource, onApplySuggestion,
  } = props
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(file.name)

  useEffect(() => {
    if (editing) {
      setDraft(file.name)
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 0)
    }
  }, [editing, file.name])

  const translatedPct = progress && progress.total > 0
    ? Math.round((progress.translated / progress.total) * 100) : 0
  const validatedPct = progress && progress.total > 0
    ? Math.round((progress.validated / progress.total) * 100) : 0
  const canExpand = fileHasSections(file)
  // Timeline-segment-model: a file is either time-true (timeline spine) or
  // sequence-true (intrinsic order). Sequence is the default, so only the
  // exceptional timeline files carry a marker — repeating an icon on every
  // row says nothing.
  const isTimeOrdered = fileOrderedBy(file) === "time"
  const fileNameTooltip = file.originalName && file.originalName !== file.name
    ? t("nav.fileRow.importedAsTooltip", { name: file.name, originalName: file.originalName })
    : file.name

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            // Showcase label: addressable, readable target for video scripts/cursor
            // (see docs/distribution/SHOWCASE-LABELS.md). The whole row is the click
            // target that opens the file — what "click the sidebar file" should hit.
            data-showcase="sidebar.file"
            data-showcase-name={file.name}
            className={cn(
              "group relative flex h-7 items-center gap-1 rounded-lg px-2 text-[13px] transition-colors",
              active ? "bg-accent text-foreground" : "hover:bg-accent",
            )}
            onClick={() => { if (!editing) onSelect() }}
            onKeyDown={(e) => {
              if (editing) return
              if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey) {
                e.preventDefault(); onStartRename()
              }
            }}
            tabIndex={0}
          />
        }
      >
        {canExpand ? (
          <AppTooltip
            content={expanded ? t("nav.fileRow.collapseSections") : t("nav.fileRow.expandSections")}
            side="right"
          >
            <button
              className="p-0.5 rounded-md text-muted-foreground transition-colors hover:text-foreground"
              onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
              aria-label={expanded ? t("nav.fileRow.collapse") : t("nav.fileRow.expand")}
            >
              <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
            </button>
          </AppTooltip>
        ) : (
          <span className="w-[18px] shrink-0" aria-hidden="true" />
        )}
        {isTimeOrdered && (
          <AppTooltip content={t("nav.fileRow.timelineOrderedTooltip")} side="right">
            <span
              className="shrink-0 text-muted-foreground/70"
              aria-label={t("nav.fileRow.timelineOrderedFile")}
            >
              <AudioWaveform className="h-3.5 w-3.5" />
            </span>
          </AppTooltip>
        )}
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => onEditCommit(draft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); onEditCommit(draft) }
                else if (e.key === "Escape") { e.preventDefault(); onEditCancel() }
              }}
              className="w-full select-text rounded-lg bg-background px-2 py-0.5 text-sm outline-none"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <AppTooltip content={fileNameTooltip} side="right">
              <button
                type="button"
                tabIndex={-1}
                className="block w-full truncate text-start"
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect()
                }}
              >
                {file.name}
              </button>
            </AppTooltip>
          )}
        </div>
        {/* AQU-341: reserve a fixed-width slot for the progress meter whether or
            not this file has progress, so the `flex-1 min-w-0` name column above
            keeps the same width across every row. Rendering the meter only when
            progress exists let same-named files diverge: a fully-imported file
            (meter shown) and a partial/empty import residue of the same name (no
            meter) gave their name labels different available widths, so they
            truncated at different points. A stable reservation makes identical
            names truncate identically. */}
        {!editing && (
          <div
            className="flex w-[50px] shrink-0 items-center justify-end gap-0.5"
            data-testid="file-row-progress-slot"
            aria-label={
              progress && progress.total > 0
                ? t("nav.fileRow.progressAriaLabel", { translated: translatedPct, validated: validatedPct })
                : undefined
            }
          >
            {progress && progress.total > 0 && (
              <>
                <span className="h-2 w-6 rounded-full bg-muted overflow-hidden">
                  <span className="block h-full bg-amber-500" style={{ width: `${translatedPct}%` }} />
                </span>
                <span className="h-2 w-6 rounded-full bg-muted overflow-hidden">
                  <span className="block h-full bg-emerald-500" style={{ width: `${validatedPct}%` }} />
                </span>
              </>
            )}
          </div>
        )}
        {!editing && (
          <AppTooltip content={t("nav.fileRow.fileActions")} side="right">
            <button
              className="p-1 rounded-md text-muted-foreground opacity-0 transition-colors hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                openContextMenuAtPointer(e.currentTarget, e.clientX, e.clientY)
              }}
              aria-label={t("nav.fileRow.fileActions")}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </AppTooltip>
        )}
        {hasSuggestion && !editing && (
          <AppTooltip content={t("nav.fileRow.suggestionTooltip")} side="right" className="max-w-xs">
            <button
              className="p-1 rounded-md shrink-0 transition-colors hover:text-foreground"
              onClick={(e) => { e.stopPropagation(); onApplySuggestion?.() }}
              aria-label={t("nav.fileRow.applyRenameSuggestion")}
            >
              <Sparkles className="h-3 w-3 text-amber-500" />
            </button>
          </AppTooltip>
        )}
      </ContextMenuTrigger>
      <FileActionMenu
        onShowDetails={onShowDetails}
        onRename={onStartRename}
        onMove={onMove}
        onDelete={onDelete}
        onExportSource={onExportSource}
      />
    </ContextMenu>
  )
}
