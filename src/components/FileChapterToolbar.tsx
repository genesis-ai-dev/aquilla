import { useMemo, useSyncExternalStore, type RefObject, type ReactNode } from "react"
import { ListChecks, LoaderCircle, WandSparkles } from "lucide-react"
import { CheckFileButton } from "@/components/CheckFileButton"
import { EditorModeToggle, type EditorLens } from "@/components/EditorModeToggle"
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu"
import type { CheckRunResult } from "@/lib/check/deterministic-check"
import { Switch } from "@/components/ui/switch"
import { AppTooltip } from "@/components/ui/tooltip"

/** Tailwind `sm` — below this, Check file folds into the ⋯ menu. */
const SM_MIN_WIDTH_QUERY = "(min-width: 640px)"

function useIsSmUp(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mq = window.matchMedia(SM_MIN_WIDTH_QUERY)
      mq.addEventListener("change", onStoreChange)
      return () => mq.removeEventListener("change", onStoreChange)
    },
    () => window.matchMedia(SM_MIN_WIDTH_QUERY).matches,
    () => true,
  )
}

interface FileChapterToolbarProps {
  lens: EditorLens
  onLensChange: (lens: EditorLens) => void
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

/** Chapter-row right-side controls: lens switch, file check, and overflow menu. */
export function FileChapterToolbar({
  lens,
  onLensChange,
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
  const smUp = useIsSmUp()

  const overflowItems = useMemo((): OverflowMenuItem[] => {
    if (smUp) return menuItems
    const checkLabel = checkRunning
      ? "Checking…"
      : checkOpen
        ? "Close file check"
        : "Check file"
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
      {
        id: "check-file",
        label: checkLabel,
        icon: ListChecks,
        badge,
        disabled: checkRunning,
        onClick: onCheckToggle,
      },
      ...menuItems,
    ]
  }, [smUp, menuItems, checkOpen, checkRunning, checkResult, onCheckToggle])

  return (
    // Keep the portal-only viewSettingsMenu outside the gap flex — an empty
    // sibling still consumes gap and pads the ⋯ button away from the edge.
    <div className="relative flex shrink-0 items-center">
      <div className="flex items-center gap-2">
        <EditorModeToggle
          lens={lens}
          onChange={onLensChange}
          timeOrdered={timeOrdered}
        />
        {onTranslateAsReadChange ? (
          <AppTooltip
            content={translateAsReadDisabled
              ? "AI translation is unavailable or this file is read-only"
              : "Draft visible empty cells. Refresh untouched AI drafts only when better evidence is available."}
          >
            <div className={translateAsReadDisabled
              ? "flex cursor-not-allowed items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs text-muted-foreground opacity-60"
              : "flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-xs transition-colors hover:bg-accent"}
            >
              {translateAsReadActive
                ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-primary" />
                : <WandSparkles className="h-3.5 w-3.5 text-primary" />}
              <span className="hidden whitespace-nowrap lg:inline">Translate as read</span>
              <Switch
                size="sm"
                aria-label="Translate as read"
                checked={translateAsReadEnabled}
                disabled={translateAsReadDisabled}
                onCheckedChange={onTranslateAsReadChange}
              />
            </div>
          </AppTooltip>
        ) : null}
        {/* Really small: Check file lives in the ⋯ menu instead. */}
        <div className="hidden sm:contents">
          <CheckFileButton
            checkOpen={checkOpen}
            checkRunning={checkRunning}
            checkResult={checkResult}
            onToggle={onCheckToggle}
          />
        </div>
        <OverflowMenu
          items={overflowItems}
          triggerRef={fileOptionsAnchorRef}
          triggerVariant="outline"
          triggerSize="icon"
          triggerClassName="bg-card shadow-xs"
          tooltip="File options"
          ariaLabel="File options"
          testId="file-options-menu"
        />
      </div>
      {viewSettingsMenu}
    </div>
  )
}
