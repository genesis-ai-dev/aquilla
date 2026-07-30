import { useState, forwardRef, useImperativeHandle, type ReactNode, type RefObject } from "react"
import { AlertTriangle, Settings, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { SegmentTabs } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { MIN_FONT_SIZE, MAX_FONT_SIZE, FONT_SIZE_STEP } from "@/lib/store/file-view-prefs"
import type { FootnoteViewMode } from "@/lib/footnotes/types"
import type { DirectionMode, TextDirection, TextDirectionSummary } from "@/lib/text-direction"

export interface ViewSettingsMenuHandle {
  open: () => void
}

interface ViewSettingsMenuProps {
  /** When set, the popover anchors to this element instead of the eye trigger. */
  anchor?: RefObject<HTMLElement | null>
  /** When true, the eye trigger is visually hidden — open via ref/imperative handle. */
  hideTrigger?: boolean
  fileOpen: boolean
  lineNumbersEnabled: boolean
  sourceDirectionMode: DirectionMode
  targetDirectionMode: DirectionMode
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

const FOOTNOTE_OPTIONS: { value: FootnoteViewMode; label: string }[] = [
  { value: "off", label: "Hidden" },
  { value: "inline", label: "Inline under cells" },
  { value: "tray", label: "Bottom tray" },
]

export const ViewSettingsMenu = forwardRef<ViewSettingsMenuHandle, ViewSettingsMenuProps>(function ViewSettingsMenu({
  anchor,
  hideTrigger = false,
  fileOpen,
  lineNumbersEnabled,
  sourceDirectionMode,
  targetDirectionMode,
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
    // When anchored to the file-options ⋯ button, skip the header-only gap hack.
    <div className={cn("relative flex items-center", hideTrigger && !anchor && "-ml-1")}>
      {showMismatchWarning && mismatch && (
        <div
          className={cn(
            "absolute right-full top-1/2 z-30 mr-2 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap",
            "rounded-2xl bg-card px-3 py-2 text-xs",
            "animate-in fade-in-0 slide-in-from-right-2 duration-200",
          )}
          role="status"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
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
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        {!anchor && (
          <AppTooltip content="Editor settings">
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Editor settings"
                  className={cn(hideTrigger ? "sr-only" : "relative")}
                >
                  <Settings className="h-4 w-4" />
                </Button>
              }
            />
          </AppTooltip>
        )}
        <PopoverContent
          anchor={anchor}
          align="end"
          side="bottom"
          sideOffset={4}
          data-testid="view-settings-popover"
          className="w-72"
        >
          <PopoverTitle className="sr-only">Editor settings</PopoverTitle>

          <FieldGroup className="gap-3">
            <SwitchRow
              id="view-show-line-numbers"
              label="Show line numbers"
              checked={lineNumbersEnabled}
              disabled={!fileOpen}
              onCheckedChange={onLineNumbersChange}
            />
            <SwitchRow
              id="view-show-cell-labels"
              label="Show cell labels"
              checked={cellLabelsEnabled}
              onCheckedChange={onCellLabelsChange}
            />
            <SwitchRow
              id="view-show-translation-notes"
              label="Show translation notes"
              checked={tnSidebarEnabled}
              onCheckedChange={onTnSidebarChange}
            />
          </FieldGroup>

          {onFootnoteViewModeChange && (
            <>
              <Separator />
              <div className="flex flex-col gap-2">
                <SectionLabel>Footnotes</SectionLabel>
                <RadioGroup
                  value={footnoteViewMode}
                  disabled={!fileOpen}
                  onValueChange={(value) => onFootnoteViewModeChange(value as FootnoteViewMode)}
                  className="gap-2"
                >
                  {FOOTNOTE_OPTIONS.map((option) => {
                    const id = `footnote-mode-${option.value}`
                    return (
                      <div key={option.value} className="flex items-center gap-3">
                        <RadioGroupItem id={id} value={option.value} />
                        <Label htmlFor={id} layout="inline" className="font-normal">
                          {option.label}
                        </Label>
                      </div>
                    )
                  })}
                </RadioGroup>
              </div>
            </>
          )}

          <Separator />
          <div className="flex flex-col gap-2">
            <SectionLabel>Text Direction</SectionLabel>
            <DirectionModeRow
              label="Source"
              disabled={!fileOpen}
              mode={sourceDirectionMode}
              onChange={onSourceDirectionModeChange}
            />
            <DirectionModeRow
              label="Target"
              disabled={!fileOpen}
              mode={targetDirectionMode}
              onChange={onTargetDirectionModeChange}
            />
          </div>

          <Separator />
          <div className="flex flex-col gap-2">
            <SectionLabel>Font Size</SectionLabel>
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
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
})

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs font-medium text-muted-foreground">
      {children}
    </div>
  )
}

function SwitchRow({
  id,
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string
  label: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal" data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id} className="font-normal">
        {label}
      </FieldLabel>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next)}
        aria-label={label}
      />
    </Field>
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
        "flex select-none items-center justify-between gap-2 text-sm",
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
  disabled,
  onChange,
}: {
  label: string
  mode: DirectionMode
  disabled: boolean
  onChange: (mode: DirectionMode) => void
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", disabled && "opacity-50")}>
      <span className="text-sm">{label}</span>
      <SegmentTabs<DirectionMode>
        value={mode}
        onValueChange={onChange}
        aria-label={`${label} direction`}
        listClassName="w-full"
        options={[
          { label: "Auto", value: "auto", disabled },
          { label: "LTR", value: "ltr", disabled },
          { label: "RTL", value: "rtl", disabled },
        ]}
      />
    </div>
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
