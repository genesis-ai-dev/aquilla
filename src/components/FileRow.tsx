import { useEffect, useMemo, useRef, useState } from "react"
import { fileDisplayName } from "@/lib/file-display-name"
import { ChevronRight, MoreHorizontal, Sparkles } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { fileHasSections } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { createMenuHandle } from "@/components/ui/menu-parts"
import { FileActionMenu, type FileReorderActions } from "./FileActionMenu"
import { useT } from "@/lib/i18n/I18nProvider"
import { progressPercent } from "@/lib/progress/progress-percent"
import { audioProgressSegments, textProgressSegments } from "@/lib/progress/progress-palette"
import { ProgressSplitBar } from "@/components/progress/ProgressSplitBar"
import { fileProgressView, type FileStats } from "@/lib/progress/file-summary-progress"

interface FileRowProps {
  file: FileReference
  active: boolean
  expanded: boolean
  expandable?: boolean
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
  /** Opens the Export dialog for this file. */
  onExport?: () => void
  onDownloadOriginal?: () => void
  /** Opens Assign work scoped to this file. Hidden when the caller cannot assign. */
  onAssignWork?: () => void
  /**
   * AQU-894: this project uses assignments, the caller holds some, and this
   * file is not among them. De-emphasises the row so the caller's own files
   * read as theirs.
   *
   * DE-EMPHASIS, NOT A LOCK. The row stays clickable and every action stays
   * available: an assignment is a coordination hint, not a permission grant
   * (05-user-stories/assign-cell-to-member.md), so making these rows
   * unreachable would invent an access rule the server doesn't enforce and
   * strand anyone who needs a file nobody thought to assign.
   */
  unassigned?: boolean
  /** Opens the Segmentation dialog for this file. */
  onSegmentation?: () => void
  /** Opens the single-file re-import dialog. */
  onReimport?: () => void
  /** AQU-981: opens "Upload recordings" for this file. */
  onUploadRecordings?: () => void
  /** AQU-271: Optional — pass undefined to hide delete for roles below project_lead. */
  onDelete?: () => void
  onApplySuggestion?: () => void
  /** AQU-1569: Move up / Move down for this row. Omit below Project Lead —
   *  the drag handle is withheld from those roles too. */
  reorder?: FileReorderActions
}

export function FileRow(props: FileRowProps) {
  const {
    file, active, expanded, progress, hasSuggestion, editing,
    onEditCommit, onEditCancel, onToggleExpand, onSelect, onShowDetails, onStartRename,
    onMove, onExport, onDownloadOriginal, onAssignWork, onSegmentation, onReimport, onUploadRecordings, onDelete,
    onApplySuggestion, unassigned = false, reorder,
  } = props
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(file.name)
  const actionsMenu = useMemo(() => createMenuHandle(), [])

  useEffect(() => {
    if (editing) {
      setDraft(file.name)
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 0)
    }
  }, [editing, file.name])

  // AQU-1493: never 100 while a cell is outstanding. Text and audio carries
  // its text half separately (its `translated` / `validated` are the lines
  // started / done), so its text bar reads the same figures a file holding
  // both reads when nobody has chosen.
  const bothLanguage = progress?.delivers === "text_and_audio"
  const translatedPct = progress
    ? progressPercent(bothLanguage ? progress.textTranslated ?? progress.translated : progress.translated, progress.total) : 0
  const validatedPct = progress
    ? progressPercent(bothLanguage ? progress.textValidated ?? progress.validated : progress.validated, progress.total) : 0
  // AQU-2111: and the audio half, for a project whose target language has no
  // written form. `recorded` absent means this row has no audio figures — an
  // older sync-worker, or the live count before the attachment map lands — and
  // absent must never draw as "0% recorded", which is the bug being fixed.
  // An Audio language's started / done lines ARE its recorded / approved ones.
  const audioLanguage = progress?.delivers === "audio"
  const recordedPct = progress
    ? progressPercent(progress.recorded ?? (audioLanguage ? progress.translated : 0), progress.total) : 0
  const audioValidatedPct = progress
    ? progressPercent(progress.audioValidated ?? (audioLanguage ? progress.validated : 0), progress.total) : 0
  // The display rule AQU-2110 settled: audio only when there is no target text
  // in this lane, both when there is, text alone when there is no audio. What
  // the language delivers wins where someone has chosen (media redesign). Text
  // and audio draws its text and its audio as two bars, the same as a file
  // holding both when nobody has chosen; it owes audio, so its audio bar shows
  // before the first recording, as an Audio language's does.
  const view = fileProgressView(progress)
  const showText = view !== "audio"
  const showAudio = view !== "text" && (audioLanguage || bothLanguage || (progress?.recorded ?? 0) > 0)
  const canExpand = props.expandable ?? fileHasSections(file)
  // AQU-1758 (Sam): no marker for a timed file any more — every file opens on
  // the timeline in Media, so "they're all media files".
  // AQU-1937: an extension's display label is what the row shows; the hover
  // keeps the stored (imported) name reachable.
  const shownName = fileDisplayName(file)
  const baseNameTooltip = shownName !== file.name
    ? t("nav.fileRow.importedAsTooltip", { name: shownName, originalName: file.name })
    : file.originalName && file.originalName !== file.name
      ? t("nav.fileRow.importedAsTooltip", { name: file.name, originalName: file.originalName })
      : file.name
  // The dimming has to say why, or it reads as "broken" / "still loading".
  // It rides the name tooltip the row already has rather than adding a second
  // hover target to a 28px row.
  const fileNameTooltip = unassigned
    ? t("nav.fileRow.notAssignedTooltip", { name: baseNameTooltip })
    : baseNameTooltip

  // The same items under both roots: right-click anywhere on the row, or the ⋯
  // button. Two roots because a context menu always anchors to the pointer.
  const actions = (
    <FileActionMenu
      onShowDetails={onShowDetails}
      onRename={onStartRename}
      onMove={onMove}
      onExport={onExport}
      onDownloadOriginal={onDownloadOriginal}
      onAssignWork={onAssignWork}
      onSegmentation={onSegmentation}
      onReimport={onReimport}
      onUploadRecordings={onUploadRecordings}
      onDelete={onDelete}
      reorder={reorder}
    />
  )

  return (
    // A handle, because neither root can contain the other: the ⋯ button has to
    // sit inside the row (the context-menu trigger), while its popup has to stay
    // outside it — React bubbles a portal's events along the React tree, and a
    // click on the row opens the file.
    <>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              // Showcase label: addressable, readable target for video scripts/cursor
              // (see docs/distribution/SHOWCASE-LABELS.md). The whole row is the click
              // target that opens the file — what "click the sidebar file" should hit.
              data-showcase="sidebar.file"
              data-showcase-name={shownName}
              data-unassigned={unassigned ? "true" : undefined}
              className={cn(
                "group relative flex h-7 items-center gap-1 rounded-lg px-2 text-[13px] transition-colors",
                active ? "bg-accent text-foreground" : "hover:bg-accent",
                // AQU-894: recede, don't disappear — and come back to full
                // strength on hover/focus so the row never feels unusable.
                unassigned && !active && "opacity-55 hover:opacity-100 focus-within:opacity-100",
              )}
              onClick={() => { if (!editing) onSelect() }}
              onKeyDown={(e) => {
                if (editing || e.target !== e.currentTarget) return
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault(); onSelect(); return
                }
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
                <ChevronRight className={cn("h-3 w-3", expanded && "rotate-90")} />
              </button>
            </AppTooltip>
          ) : (
            <span className="w-[18px] shrink-0" aria-hidden="true" />
          )}
          {/* AQU-894: dimming is invisible to a screen reader, so the reason
              is also stated in text. Same sentence as the hover tooltip —
              including "you can still open it", because a row announced only
              as "not assigned to you" reads as a closed door. */}
          {unassigned && (
            <span className="sr-only">{t("nav.fileRow.notAssignedToYou")}</span>
          )}
          <div className="flex-1 min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                aria-label={file.name}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => onEditCommit(draft)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); onEditCommit(draft) }
                  else if (e.key === "Escape") { e.preventDefault(); onEditCancel() }
                }}
                autoComplete="off"
                className="w-full select-text rounded-lg bg-background px-2 py-0.5 text-sm outline-none"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <AppTooltip content={fileNameTooltip} side="right">
                <button
                  type="button"
                  className="block w-full truncate text-left"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelect()
                  }}
                >
                  {shownName}
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
                  ? showText
                    ? showAudio
                      ? t("nav.fileRow.progressWithAudioAriaLabel", {
                          translated: translatedPct,
                          validated: validatedPct,
                          recorded: recordedPct,
                          audioValidated: audioValidatedPct,
                        })
                      : t("nav.fileRow.progressAriaLabel", { translated: translatedPct, validated: validatedPct })
                    : t("nav.fileRow.audioProgressAriaLabel", {
                        recorded: recordedPct,
                        audioValidated: audioValidatedPct,
                      })
                  : undefined
              }
            >
              {/* AQU-1764: ONE two-part bar across the slot — validated in
                  the dark blue, then translated but not validated in the
                  light one — where there were two side-by-side bars in amber
                  and emerald. Drawn from the same two percentages the slot's
                  label reads out. */}
              {/* AQU-2111: with both media the slot holds two thinner stacked
                  tracks — text above, audio below — so the 50px reservation
                  (and therefore where every row's name truncates) is
                  untouched. A file with one medium keeps the single 8px bar. */}
              {progress && progress.total > 0 && (
                <span className="flex w-full flex-col gap-0.5">
                  {showText && (
                    <ProgressSplitBar
                      segments={textProgressSegments({ validated: validatedPct, translated: translatedPct, total: 100 })}
                      height={showAudio ? 4 : 8}
                      className="w-full"
                    />
                  )}
                  {showAudio && (
                    <ProgressSplitBar
                      segments={audioProgressSegments({ validated: audioValidatedPct, recorded: recordedPct, total: 100 })}
                      height={showText ? 4 : 8}
                      className="w-full"
                    />
                  )}
                </span>
              )}
            </div>
          )}
          {!editing && (
            <DropdownMenuTrigger
              handle={actionsMenu}
              className="rounded-md p-1 text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 aria-expanded:opacity-100 aria-expanded:text-foreground"
              // The row itself opens the file; this press belongs to the menu.
              onClick={(e) => e.stopPropagation()}
              aria-label={t("nav.fileRow.fileActions")}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
          )}
          {hasSuggestion && !editing && (
            // The hover names it (AQU-2260); "a cleaner name was detected" is
            // what the name already says.
            <AppTooltip content={t("nav.fileRow.applyRenameSuggestion")} side="right">
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
        <ContextMenuContent className="w-44">{actions}</ContextMenuContent>
      </ContextMenu>
      <DropdownMenu handle={actionsMenu}>
        <DropdownMenuContent align="end" className="w-44">
          {actions}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
