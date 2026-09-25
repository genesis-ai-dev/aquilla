import { useMemo, type RefObject, type ReactNode } from "react"
import { Eye, EyeOff, ListChecks, LoaderCircle, WandSparkles } from "lucide-react"
import { EditorModeToggle, type EditorLens } from "@/components/EditorModeToggle"
import { EDITOR_SURFACE_OVERFLOW_TRIGGER_CLASS } from "@/components/editor-surface-toolbar"
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { CheckRunResult } from "@/lib/check/deterministic-check"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * AQU-1422: the "N hidden" indicator and its reveal toggle, in one control.
 *
 * Both jobs belong to one button because they answer one question. The count is
 * the standing answer to "what have I parked in this file?", and the only useful
 * next move is to look at them — so the thing that tells you is the thing that
 * shows you, rather than a badge here and a switch three menus away.
 *
 * The workspace passes this ONLY to someone who may park cells, and only when
 * the count is above zero, so there is no permission check and no zero state
 * here: a reader is never handed the prop, and a source editor with nothing
 * hidden sees no furniture.
 */
export interface HiddenCellsIndicatorProps {
  /** How many cells in this file are parked. Always ≥ 1 when passed. */
  count: number
  /** Are they currently being drawn (dimmed) rather than dropped? */
  revealed: boolean
  onRevealedChange: (revealed: boolean) => void
}

interface FileChapterToolbarProps {
  lens: EditorLens
  onLensChange: (lens: EditorLens) => void
  onAgentSelect?: () => void
  agentActive?: boolean
  timeOrdered?: boolean
  checkOpen: boolean
  checkRunning: boolean
  checkResult: CheckRunResult | null
  onCheckToggle: () => void
  menuItems: OverflowMenuItem[]
  fileOptionsAnchorRef?: RefObject<HTMLButtonElement | null>
  viewSettingsMenu?: ReactNode
  /** AQU-1422: absent ⇒ nothing is hidden, or this person may not park cells. */
  hiddenCells?: HiddenCellsIndicatorProps
  translateAsReadEnabled?: boolean
  translateAsReadDisabled?: boolean
  translateAsReadActive?: boolean
  onTranslateAsReadChange?: (enabled: boolean) => void
}

/** Chapter-row right-side controls: mode switch and file-options menu. */
export function FileChapterToolbar({
  lens,
  onLensChange,
  onAgentSelect,
  agentActive = false,
  timeOrdered = false,
  checkOpen,
  checkRunning,
  checkResult,
  onCheckToggle,
  menuItems,
  fileOptionsAnchorRef,
  viewSettingsMenu,
  hiddenCells,
  translateAsReadEnabled = false,
  translateAsReadDisabled = false,
  translateAsReadActive = false,
  onTranslateAsReadChange,
}: FileChapterToolbarProps) {
  const t = useT()

  const overflowItems = useMemo((): OverflowMenuItem[] => {
    const checkLabel = checkRunning
      ? "Checking…"
      : t("rules.checkFileButton.label")
    const badge = checkResult && !checkRunning ? (
      <span
        className={checkResult.totalFindingCount > 0
          ? "rounded-md bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-300"
          : "rounded-md bg-green-100 px-1.5 text-[10px] font-semibold text-green-800 dark:bg-green-900/50 dark:text-green-300"}
      >
        {checkResult.totalFindingCount}
      </span>
    ) : undefined
    return [
      ...(onTranslateAsReadChange ? [{
        id: "translate-as-read",
        type: "checkbox" as const,
        label: t("agentWorkspace.translateAsRead"),
        description: t("agentWorkspace.translateAsReadHelp"),
        icon: translateAsReadActive ? LoaderCircle : WandSparkles,
        checked: translateAsReadEnabled,
        disabled: translateAsReadDisabled,
        onCheckedChange: onTranslateAsReadChange,
      }] : []),
      {
        id: "check-file",
        type: "checkbox",
        label: checkLabel,
        icon: ListChecks,
        checked: checkOpen,
        badge,
        disabled: checkRunning,
        onCheckedChange: onCheckToggle,
      },
      ...(menuItems.length > 0 ? [{
        id: "toolbar-controls-separator",
        type: "separator" as const,
      }] : []),
      ...menuItems,
    ]
  }, [
    menuItems,
    checkOpen,
    checkRunning,
    checkResult,
    onCheckToggle,
    onTranslateAsReadChange,
    t,
    translateAsReadActive,
    translateAsReadDisabled,
    translateAsReadEnabled,
  ])

  return (
    // Keep the portal-only viewSettingsMenu outside the gap flex — an empty
    // sibling still consumes gap and pads the ⋯ button away from the edge.
    <div className="relative flex shrink-0 items-center">
      <div className="flex items-center gap-2">
        {hiddenCells && (
          <AppTooltip content={t("editor.hiddenCells.indicatorTooltip", { count: hiddenCells.count })}>
            <button
              type="button"
              data-testid="hidden-cells-indicator"
              // Exposed as state rather than left to a class check: the button's
              // two appearances differ only by tint, and a test asserting on a
              // colour class would pin the styling instead of the behaviour.
              data-revealed={hiddenCells.revealed ? "true" : "false"}
              aria-pressed={hiddenCells.revealed}
              title={t("editor.hiddenCells.toggle")}
              onClick={() => hiddenCells.onRevealedChange(!hiddenCells.revealed)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
                hiddenCells.revealed
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {hiddenCells.revealed
                ? <Eye className="h-3.5 w-3.5 shrink-0" />
                : <EyeOff className="h-3.5 w-3.5 shrink-0" />}
              <span>{t("editor.hiddenCells.indicator", { count: hiddenCells.count })}</span>
            </button>
          </AppTooltip>
        )}
        <EditorModeToggle
          lens={lens}
          onChange={onLensChange}
          onAgentSelect={onAgentSelect}
          agentActive={agentActive}
          timeOrdered={timeOrdered}
        />
        <OverflowMenu
          items={overflowItems}
          triggerRef={fileOptionsAnchorRef}
          triggerVariant="outline"
          triggerSize="icon"
          triggerClassName={EDITOR_SURFACE_OVERFLOW_TRIGGER_CLASS}
          ariaLabel="File options"
          testId="file-options-menu"
        />
      </div>
      {viewSettingsMenu}
    </div>
  )
}
