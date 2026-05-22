import { useState, useEffect } from "react"
import { Menu } from "@base-ui/react/menu"
import { Eye, X, Languages } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ViewSettingsMenuProps {
  fileOpen: boolean
  lineNumbersEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  cellLabelsEnabled: boolean
  rtlHintDismissed?: boolean
  onLineNumbersChange: (v: boolean) => void
  onSourceTextDirectionChange: (v: "ltr" | "rtl") => void
  onTargetTextDirectionChange: (v: "ltr" | "rtl") => void
  onCellLabelsChange: (v: boolean) => void
  onDismissRtlHint?: () => void
}

export function ViewSettingsMenu({
  fileOpen,
  lineNumbersEnabled,
  sourceTextDirection,
  targetTextDirection,
  cellLabelsEnabled,
  rtlHintDismissed = true,
  onLineNumbersChange,
  onSourceTextDirectionChange,
  onTargetTextDirectionChange,
  onCellLabelsChange,
  onDismissRtlHint,
}: ViewSettingsMenuProps) {
  const rtlDetected = sourceTextDirection === "rtl" || targetTextDirection === "rtl"
  const showHint = fileOpen && rtlDetected && !rtlHintDismissed
  const [menuOpen, setMenuOpen] = useState(false)
  const [hintVisible, setHintVisible] = useState(showHint)

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
    <div className="relative flex items-center">
      {/* Auto-popover nudge when we detect RTL and user hasn't acknowledged */}
      {hintVisible && (
        <div
          className={cn(
            "absolute right-full top-1/2 z-30 mr-2 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap",
            "rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg",
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
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-primary transition-[transform,color] duration-150 ease-out hover:bg-primary/10 active:scale-[0.95]"
          >
            Adjust
          </button>
          <button
            type="button"
            onClick={handleDismissHint}
            title="Dismiss"
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/70 transition-[transform,color] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.92]"
          >
            <X className="h-3 w-3" />
          </button>
          {/* Arrow pointing to the eye icon */}
          <span
            className="absolute left-full top-1/2 -translate-y-1/2 border-y-4 border-l-4 border-y-transparent border-l-popover"
            aria-hidden="true"
          />
        </div>
      )}

      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Menu.Trigger
          render={
            <Button variant="ghost" size="sm" title="View settings" className="relative">
              <Eye className="h-4 w-4" />
              {showHint && (
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
            <Menu.Popup className="min-w-60 rounded-xl border bg-popover p-1 text-popover-foreground shadow-soft-lg">
              <Menu.Item
                disabled={!fileOpen}
                onClick={() => onLineNumbersChange(!lineNumbersEnabled)}
                className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
              >
                <span>Show line numbers</span>
                <Pill on={lineNumbersEnabled} />
              </Menu.Item>
              <Menu.Item
                onClick={() => onCellLabelsChange(!cellLabelsEnabled)}
                className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
              >
                <span>Show cell labels</span>
                <Pill on={cellLabelsEnabled} />
              </Menu.Item>
              <div className="-mx-1 my-1 h-px bg-border" role="separator" />
              <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Text Direction
              </div>
              <Menu.Item
                disabled={!fileOpen}
                onClick={() => onSourceTextDirectionChange(sourceTextDirection === "ltr" ? "rtl" : "ltr")}
                className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
              >
                <span>Source</span>
                <DirPill dir={sourceTextDirection} />
              </Menu.Item>
              <Menu.Item
                disabled={!fileOpen}
                onClick={() => onTargetTextDirectionChange(targetTextDirection === "ltr" ? "rtl" : "ltr")}
                className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
              >
                <span>Target</span>
                <DirPill dir={targetTextDirection} />
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  )
}

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

function DirPill({ dir }: { dir: "ltr" | "rtl" }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
      {dir.toUpperCase()}
    </span>
  )
}
