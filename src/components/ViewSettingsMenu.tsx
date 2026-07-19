import { useState, forwardRef, useImperativeHandle } from "react"
import { Menu } from "@base-ui/react/menu"
import { AlertTriangle, Eye, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { MIN_FONT_SIZE, MAX_FONT_SIZE, FONT_SIZE_STEP } from "@/lib/store/file-view-prefs"
import type { FootnoteViewMode } from "@/lib/footnotes/types"
import type { DirectionMode, TextDirection, TextDirectionSummary } from "@/lib/text-direction"

export interface ViewSettingsMenuHandle {
  open: () => void
}

interface ViewSettingsMenuProps {
  /** When true, the eye trigger is visually hidden — open via ref/imperative handle. */
  hideTrigger?: boolean
  fileOpen: boolean
  lineNumbersEnabled: boolean
  sourceDirectionMode: DirectionMode
  targetDirectionMode: DirectionMode
  sourceTextDirection: TextDirection
  targetTextDirection: TextDirection
  sourceAutoDirectionSummary?: TextDirectionSummary | null
  targetAutoDirectionSummary?: TextDirectionSummary | null
  directionWarningScope?: string | null
  cellLabelsEnabled: boolean
  tnSidebarEnabled: boolean
  /** AQU-317: USFM \f...\f* footnote display mode. */
  footnoteViewMode?: FootnoteViewMode
  /** Per-file source-column font size in px. */
  sourceFontSize: number
  /** Per-file target-column font size in px. */
  targetFontSize: number
  onLineNumbersChange: (v: boolean) => void
  onSourceDirectionModeChange: (v: DirectionMode) => void
  onTargetDirectionModeChange: (v: DirectionMode) => void
  onCellLabelsChange: (v: boolean) => void
  onSourceFontSizeChange: (v: number) => void
  onTargetFontSizeChange: (v: number) => void
  onTnSidebarChange: (v: boolean) => void
  onFootnoteViewModeChange?: (v: FootnoteViewMode) => void
}

export const ViewSettingsMenu = forwardRef<ViewSettingsMenuHandle, ViewSettingsMenuProps>(function ViewSettingsMenu({
  hideTrigger = false,
  fileOpen,
  lineNumbersEnabled,
  sourceDirectionMode,
  targetDirectionMode,
  sourceTextDirection,
  targetTextDirection,
  sourceAutoDirectionSummary,
  targetAutoDirectionSummary,
  directionWarningScope,
  cellLabelsEnabled,
  tnSidebarEnabled,
  footnoteViewMode = "off",
  sourceFontSize,
  targetFontSize,
  onLineNumbersChange,
  onSourceDirectionModeChange,
  onTargetDirectionModeChange,
  onCellLabelsChange,
  onSourceFontSizeChange,
  onTargetFontSizeChange,
  onTnSidebarChange,
  onFootnoteViewModeChange,
}, ref) {
  const [menuOpen, setMenuOpen] = useState(false)
  const mismatch = getManualDirectionMismatch({
    sourceMode: sourceDirectionMode,
    targetMode: targetDirectionMode,
    sourceSummary: sourceAutoDirectionSummary,
    targetSummary: targetAutoDirectionSummary,
  })
  const mismatchSignature = mismatch
    ? `${directionWarningScope ?? ""}:${mismatch.side}:${mismatch.forced}:${mismatch.detected}`
    : null
  const [dismissedMismatchSignature, setDismissedMismatchSignature] = useState<string | null>(null)
  const showMismatchWarning = Boolean(
    fileOpen &&
    mismatch &&
    mismatchSignature &&
    dismissedMismatchSignature !== mismatchSignature &&
    !menuOpen,
  )
  const detectedManualDirection = mismatch?.detected === "mixed" ? null : (mismatch?.detected ?? null)

  useImperativeHandle(ref, () => ({
    open: () => setMenuOpen(true),
  }))

  function applyDirectionMismatchFix(mode: DirectionMode) {
    if (!mismatch) return
    if (mismatch.side === "source") onSourceDirectionModeChange(mode)
    else onTargetDirectionModeChange(mode)
  }

  return (
    // AQU-358: when the trigger is hidden (opened from the ⋯ menu) this wrapper
    // is a zero-width flex child sitting between the primary-action button and the
    // ⋯ menu; the parent's `gap-1` then renders on *both* sides of it, doubling the
    // visible gap before the ⋯. Pull it back by one gap step so the ⋯ sits tight
    // against the action button while the wrapper still anchors the warning popover.
    <div className={cn("relative flex items-center", hideTrigger && "-ml-1")}>
      {showMismatchWarning && mismatch && (
        <div
          className={cn(
            "absolute right-full top-1/2 z-30 mr-2 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap",
            "rounded-2xl bg-card px-3 py-2 text-xs",
            "animate-in fade-in-0 slide-in-from-right-2 duration-200",
          )}
          role="status"
        >
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-600" />
          <span className="text-foreground">
            {mismatch.sideLabel} is forced{" "}
            <strong>{directionName(mismatch.forced)}</strong>, but content looks{" "}
            <strong>{detectedDirectionName(mismatch.detected)}</strong>
          </span>
          <button
            type="button"
            onClick={() => applyDirectionMismatchFix("auto")}
            className="rounded-md px-2 py-0.5 text-[11px] font-medium text-primary transition-all duration-150 ease-out hover:bg-card active:scale-[0.95]"
          >
            Auto
          </button>
          {detectedManualDirection && (
            <button
              type="button"
              onClick={() => applyDirectionMismatchFix(detectedManualDirection)}
              className="rounded-md px-2 py-0.5 text-[11px] font-medium text-primary transition-all duration-150 ease-out hover:bg-card active:scale-[0.95]"
            >
              {detectedManualDirection.toUpperCase()}
            </button>
          )}
          <AppTooltip content="Dismiss">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setDismissedMismatchSignature(mismatchSignature)}
              aria-label="Dismiss direction warning"
              className="size-5 rounded-full text-muted-foreground/70"
            >
              <X className="h-3 w-3" />
            </Button>
          </AppTooltip>
          <span
            className="absolute left-full top-1/2 -translate-y-1/2 border-y-4 border-l-4 border-y-transparent border-l-card"
            aria-hidden="true"
          />
        </div>
      )}
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              size="icon"
              title="View settings"
              aria-label="View settings"
              className={cn(hideTrigger ? "sr-only" : "relative")}
            >
              <Eye className="h-4 w-4" />
            </Button>
          }
        />
        <Menu.Portal>
          {/* z-40 on Positioner, not Popup — see ui/tooltip.tsx for rationale. */}
          <Menu.Positioner sideOffset={4} className="z-40">
            <Menu.Popup className="min-w-60 rounded-2xl bg-card p-1.5 text-popover-foreground">
              <Menu.Item
                disabled={!fileOpen}
                onClick={() => onLineNumbersChange(!lineNumbersEnabled)}
                className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
              >
                <span>Show line numbers</span>
                <Pill on={lineNumbersEnabled} />
              </Menu.Item>
              <Menu.Item
                onClick={() => onCellLabelsChange(!cellLabelsEnabled)}
                className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
              >
                <span>Show cell labels</span>
                <Pill on={cellLabelsEnabled} />
              </Menu.Item>
              <Menu.Item
                onClick={() => onTnSidebarChange(!tnSidebarEnabled)}
                className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
              >
                <span>Show translation notes</span>
                <Pill on={tnSidebarEnabled} />
              </Menu.Item>
              {onFootnoteViewModeChange && (
                <>
                  <div className="-mx-1 my-1.5 h-px rounded-full" role="separator" />
                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Footnotes
                  </div>
                  <FootnoteModeItem
                    disabled={!fileOpen}
                    label="Hidden"
                    active={footnoteViewMode === "off"}
                    onSelect={() => onFootnoteViewModeChange("off")}
                  />
                  <FootnoteModeItem
                    disabled={!fileOpen}
                    label="Inline under cells"
                    active={footnoteViewMode === "inline"}
                    onSelect={() => onFootnoteViewModeChange("inline")}
                  />
                  <FootnoteModeItem
                    disabled={!fileOpen}
                    label="Bottom tray"
                    active={footnoteViewMode === "tray"}
                    onSelect={() => onFootnoteViewModeChange("tray")}
                  />
                </>
              )}
              <div className="-mx-1 my-1.5 h-px rounded-full" role="separator" />
              <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Text Direction
              </div>
              <DirectionModeRow
                label="Source"
                disabled={!fileOpen}
                mode={sourceDirectionMode}
                resolved={sourceTextDirection}
                autoSummary={sourceAutoDirectionSummary}
                onChange={onSourceDirectionModeChange}
              />
              <DirectionModeRow
                label="Target"
                disabled={!fileOpen}
                mode={targetDirectionMode}
                resolved={targetTextDirection}
                autoSummary={targetAutoDirectionSummary}
                onChange={onTargetDirectionModeChange}
              />
              <div className="-mx-1 my-1.5 h-px rounded-full" role="separator" />
              <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Font Size
              </div>
              {/* Plain rows (not Menu.Item) so stepping the size doesn't close
                  the menu — sizes are usually nudged a few clicks in a row. */}
              <FontSizeRow
                label="Source"
                value={sourceFontSize}
                disabled={!fileOpen}
                onChange={onSourceFontSizeChange}
              />
              <FontSizeRow
                label="Target"
                value={targetFontSize}
                disabled={!fileOpen}
                onChange={onTargetFontSizeChange}
              />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  )
})

function Pill({ on }: { on: boolean }) {
  return (
    <span
      className={
        "rounded-md px-2 py-0.5 text-[10px] font-medium " +
        (on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")
      }
    >
      {on ? "On" : "Off"}
    </span>
  )
}

function FootnoteModeItem({
  label,
  active,
  disabled,
  onSelect,
}: {
  label: string
  active: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <Menu.Item
      disabled={disabled}
      onClick={onSelect}
      className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
    >
      <span>{label}</span>
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          active ? "bg-primary" : "bg-muted",
        )}
        aria-hidden="true"
      />
    </Menu.Item>
  )
}

function FontSizeRow({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: number
  disabled: boolean
  onChange: (v: number) => void
}) {
  return (
    <div
      className={cn(
        "flex select-none items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm",
        disabled && "opacity-50",
      )}
    >
      <span>{label}</span>
      <span className="flex items-center gap-1">
        <AppTooltip content={`Decrease ${label.toLowerCase()} font size`}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Decrease ${label.toLowerCase()} font size`}
            disabled={disabled || value <= MIN_FONT_SIZE}
            onClick={() => onChange(Math.max(MIN_FONT_SIZE, value - FONT_SIZE_STEP))}
            className="size-5"
          >
            <span className="text-[11px] leading-none select-none">A−</span>
          </Button>
        </AppTooltip>
        <span className="w-9 text-center text-[10px] tabular-nums text-muted-foreground">{value}px</span>
        <AppTooltip content={`Increase ${label.toLowerCase()} font size`}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Increase ${label.toLowerCase()} font size`}
            disabled={disabled || value >= MAX_FONT_SIZE}
            onClick={() => onChange(Math.min(MAX_FONT_SIZE, value + FONT_SIZE_STEP))}
            className="size-5"
          >
            <span className="text-[11px] leading-none select-none">A+</span>
          </Button>
        </AppTooltip>
      </span>
    </div>
  )
}

function DirectionModeRow({
  label,
  mode,
  resolved,
  autoSummary,
  disabled,
  onChange,
}: {
  label: string
  mode: DirectionMode
  resolved: TextDirection
  autoSummary?: TextDirectionSummary | null
  disabled: boolean
  onChange: (mode: DirectionMode) => void
}) {
  const modes: DirectionMode[] = ["auto", "ltr", "rtl"]
  return (
    <div className={cn(
      "rounded-lg px-2 py-1.5",
      disabled && "opacity-50",
    )}>
      <div className="mb-1 flex items-center justify-between gap-2 text-sm">
        <span>{label}</span>
        <DirPill dir={resolved} mode={mode} autoSummary={autoSummary} />
      </div>
      <div className="grid grid-cols-3 gap-1">
        {modes.map((nextMode) => {
          const active = mode === nextMode
          return (
            <button
              key={nextMode}
              type="button"
              disabled={disabled}
              aria-label={`${label} direction ${nextMode === "auto" ? "Auto" : nextMode.toUpperCase()}`}
              aria-pressed={active}
              onClick={() => onChange(nextMode)}
              className={cn(
                "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35",
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/60 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                disabled && "cursor-not-allowed hover:bg-muted/60 hover:text-muted-foreground",
              )}
            >
              {nextMode === "auto" ? "Auto" : nextMode.toUpperCase()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function DirPill({
  dir,
  mode,
  autoSummary,
}: {
  dir: TextDirection
  mode: DirectionMode
  autoSummary?: TextDirectionSummary | null
}) {
  const label = mode === "auto" ? `AUTO ${(autoSummary ?? dir).toUpperCase()}` : dir.toUpperCase()
  return (
    <Badge variant="secondary" className="text-[10px] tabular-nums">
      {label}
    </Badge>
  )
}

interface DirectionMismatchInput {
  sourceMode: DirectionMode
  targetMode: DirectionMode
  sourceSummary?: TextDirectionSummary | null
  targetSummary?: TextDirectionSummary | null
}

interface DirectionMismatch {
  side: "source" | "target"
  sideLabel: "Source" | "Target"
  forced: TextDirection
  detected: TextDirectionSummary
}

function getManualDirectionMismatch({
  sourceMode,
  targetMode,
  sourceSummary,
  targetSummary,
}: DirectionMismatchInput): DirectionMismatch | null {
  return (
    getManualDirectionMismatchForSide("target", targetMode, targetSummary) ??
    getManualDirectionMismatchForSide("source", sourceMode, sourceSummary)
  )
}

function getManualDirectionMismatchForSide(
  side: "source" | "target",
  mode: DirectionMode,
  summary?: TextDirectionSummary | null,
): DirectionMismatch | null {
  if (mode === "auto" || summary == null) return null
  if (summary === mode) return null
  return {
    side,
    sideLabel: side === "source" ? "Source" : "Target",
    forced: mode,
    detected: summary,
  }
}

function directionName(direction: TextDirection): string {
  return direction === "rtl" ? "right-to-left" : "left-to-right"
}

function detectedDirectionName(direction: TextDirectionSummary): string {
  if (direction === "mixed") return "mixed"
  return directionName(direction)
}
