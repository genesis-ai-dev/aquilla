import { useState, useEffect, forwardRef, useImperativeHandle } from "react"
import { Menu } from "@base-ui/react/menu"
import { Eye, X, Languages } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { MIN_FONT_SIZE, MAX_FONT_SIZE, FONT_SIZE_STEP } from "@/lib/store/file-view-prefs"
import type { FootnoteViewMode } from "@/lib/footnotes/types"

export interface ViewSettingsMenuHandle {
  open: () => void
}

interface ViewSettingsMenuProps {
  /** When true, the eye trigger is visually hidden — open via ref/imperative handle or RTL hint. */
  hideTrigger?: boolean
  fileOpen: boolean
  lineNumbersEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  cellLabelsEnabled: boolean
  tnSidebarEnabled: boolean
  /** FRO-317: USFM \f...\f* footnote display mode. */
  footnoteViewMode?: FootnoteViewMode
  rtlHintDismissed?: boolean
  /** Per-file source-column font size in px. */
  sourceFontSize: number
  /** Per-file target-column font size in px. */
  targetFontSize: number
  onLineNumbersChange: (v: boolean) => void
  onSourceTextDirectionChange: (v: "ltr" | "rtl") => void
  onTargetTextDirectionChange: (v: "ltr" | "rtl") => void
  onCellLabelsChange: (v: boolean) => void
  onSourceFontSizeChange: (v: number) => void
  onTargetFontSizeChange: (v: number) => void
  onTnSidebarChange: (v: boolean) => void
  onFootnoteViewModeChange?: (v: FootnoteViewMode) => void
  onDismissRtlHint?: () => void
}

export const ViewSettingsMenu = forwardRef<ViewSettingsMenuHandle, ViewSettingsMenuProps>(function ViewSettingsMenu({
  hideTrigger = false,
  fileOpen,
  lineNumbersEnabled,
  sourceTextDirection,
  targetTextDirection,
  cellLabelsEnabled,
  tnSidebarEnabled,
  footnoteViewMode = "off",
  rtlHintDismissed = true,
  sourceFontSize,
  targetFontSize,
  onLineNumbersChange,
  onSourceTextDirectionChange,
  onTargetTextDirectionChange,
  onCellLabelsChange,
  onSourceFontSizeChange,
  onTargetFontSizeChange,
  onTnSidebarChange,
  onFootnoteViewModeChange,
  onDismissRtlHint,
}, ref) {
  const rtlDetected = sourceTextDirection === "rtl" || targetTextDirection === "rtl"
  const showHint = fileOpen && rtlDetected && !rtlHintDismissed
  const [menuOpen, setMenuOpen] = useState(false)
  const [hintVisible, setHintVisible] = useState(showHint)

  useImperativeHandle(ref, () => ({
    open: () => setMenuOpen(true),
  }))

  // Sync hint visibility with detection state — if user opens the menu, the
  // hint collapses silently (they're seeing the settings now).
  useEffect(() => {
    if (menuOpen) setHintVisible(false)
  }, [menuOpen])
  useEffect(() => {
    setHintVisible(showHint)
  }, [showHint])

  function handleDismissHint() {
    setHintVisible(false)
    onDismissRtlHint?.()
  }

  return (
    // AQU-358: when the trigger is hidden (opened from the ⋯ menu) this wrapper
    // is a zero-width flex child sitting between the primary-action button and the
    // ⋯ menu; the parent's `gap-1` then renders on *both* sides of it, doubling the
    // visible gap before the ⋯. Pull it back by one gap step so the ⋯ sits tight
    // against the action button while the wrapper still anchors the RTL hint.
    <div className={cn("relative flex items-center", hideTrigger && "-ml-1")}>
      {/* Auto-popover nudge when we detect RTL and user hasn't acknowledged */}
      {hintVisible && (
        <div
          className={cn(
            "absolute right-full top-1/2 z-30 mr-2 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap",
            "rounded-2xl bg-card px-3 py-2 text-xs",
            "animate-in fade-in-0 slide-in-from-right-2 duration-200",
          )}
          role="status"
        >
          <Languages className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
          <span className="text-foreground">
            Detected <strong>right-to-left</strong> for{" "}
            {sourceTextDirection === "rtl" && targetTextDirection === "rtl"
              ? "source and target"
              : sourceTextDirection === "rtl"
                ? "source"
                : "target"}
          </span>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(true)
              handleDismissHint()
            }}
            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-primary transition-all duration-150 ease-out hover:bg-card active:scale-[0.95]"
          >
            Adjust
          </button>
          <AppTooltip content="Dismiss">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={handleDismissHint}
              aria-label="Dismiss"
              className="size-5 rounded-full text-muted-foreground/70"
            >
              <X className="h-3 w-3" />
            </Button>
          </AppTooltip>
          {/* Arrow pointing to the eye icon */}
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
              {showHint && !hideTrigger && (
                <span
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background"
                  aria-hidden="true"
                />
              )}
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
              <Menu.Item
                disabled={!fileOpen}
                onClick={() => onSourceTextDirectionChange(sourceTextDirection === "ltr" ? "rtl" : "ltr")}
                className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
              >
                <span>Source</span>
                <DirPill dir={sourceTextDirection} />
              </Menu.Item>
              <Menu.Item
                disabled={!fileOpen}
                onClick={() => onTargetTextDirectionChange(targetTextDirection === "ltr" ? "rtl" : "ltr")}
                className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
              >
                <span>Target</span>
                <DirPill dir={targetTextDirection} />
              </Menu.Item>
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
        "rounded-full px-2 py-0.5 text-[10px] font-medium " +
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

function DirPill({ dir }: { dir: "ltr" | "rtl" }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
      {dir.toUpperCase()}
    </span>
  )
}
