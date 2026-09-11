import { useMemo, type RefObject, type ReactNode } from "react"
import { ListChecks, LoaderCircle, WandSparkles } from "lucide-react"
import { EditorModeToggle, type EditorLens } from "@/components/EditorModeToggle"
import { EDITOR_SURFACE_OVERFLOW_TRIGGER_CLASS } from "@/components/editor-surface-toolbar"
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu"
import type { CheckRunResult } from "@/lib/check/deterministic-check"
import { useT } from "@/lib/i18n/I18nProvider"

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
