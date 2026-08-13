import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  forwardRef,
  useImperativeHandle,
  type ReactNode,
  type RefObject,
} from "react"
import { Settings } from "lucide-react"
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
import { toast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import { MIN_FONT_SIZE, MAX_FONT_SIZE, FONT_SIZE_STEP } from "@/lib/store/file-view-prefs"
import type { FootnoteViewMode } from "@/lib/footnotes/types"
import type { DirectionMode, TextDirection, TextDirectionSummary } from "@/lib/text-direction"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import type { MessageKey } from "@/lib/i18n/messages/en"

/** Stable id so a lingering mismatch upserts instead of stacking. */
export const DIRECTION_MISMATCH_TOAST_ID = "editor.view.directionMismatch"

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

const FOOTNOTE_OPTIONS: { value: FootnoteViewMode; labelKey: MessageKey }[] = [
  { value: "off", labelKey: "editor.view.footnotesHidden" },
  { value: "inline", labelKey: "editor.view.footnotesInline" },
  { value: "tray", labelKey: "editor.view.footnotesTray" },
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
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const mismatch = useMemo(
    () =>
      getManualDirectionMismatch({
        sourceMode: sourceDirectionMode,
        targetMode: targetDirectionMode,
        sourceSummary: sourceAutoDirectionSummary,
        targetSummary: targetAutoDirectionSummary,
      }),
    [
      sourceDirectionMode,
      targetDirectionMode,
      sourceAutoDirectionSummary,
      targetAutoDirectionSummary,
    ],
  )
  const mismatchSignature = mismatch
    ? `${directionWarningScope ?? ""}:${mismatch.side}:${mismatch.forced}:${mismatch.detected}`
    : null
  const [dismissedMismatchSignature, setDismissedMismatchSignature] = useState<string | null>(null)
  const showMismatchWarning = Boolean(
    fileOpen &&
    mismatch &&
    mismatchSignature &&
    dismissedMismatchSignature !== mismatchSignature,
  )

  useImperativeHandle(ref, () => ({
    open: () => setMenuOpen(true),
  }))

  const applyDirectionMismatchFix = useCallback((mode: DirectionMode) => {
    if (!mismatch) return
    if (mismatch.side === "source") onSourceDirectionModeChange(mode)
    else onTargetDirectionModeChange(mode)
  }, [mismatch, onSourceDirectionModeChange, onTargetDirectionModeChange])
  const applyDirectionMismatchFixRef = useRef(applyDirectionMismatchFix)
  applyDirectionMismatchFixRef.current = applyDirectionMismatchFix

  useEffect(() => {
    if (!showMismatchWarning || !mismatch || !mismatchSignature) {
      toast.close(DIRECTION_MISMATCH_TOAST_ID)
      return
    }

    toast.add({
      id: DIRECTION_MISMATCH_TOAST_ID,
      type: "warning",
      timeout: 0,
      title: (
        <RichMessage
          k="editor.view.directionMismatch"
          values={{
            side: t(sideLabelKey(mismatch.side)),
            forced: <strong>{t(directionNameKey(mismatch.forced))}</strong>,
            detected: <strong>{t(detectedDirectionNameKey(mismatch.detected))}</strong>,
          }}
        />
      ),
      actionProps: {
        children: t("editor.view.directionAuto"),
        onClick: () => {
          applyDirectionMismatchFixRef.current("auto")
          toast.close(DIRECTION_MISMATCH_TOAST_ID)
        },
      },
      onClose: () => {
        setDismissedMismatchSignature(mismatchSignature)
      },
    })
  }, [showMismatchWarning, mismatch, mismatchSignature, t])

  useEffect(() => {
    return () => {
      toast.close(DIRECTION_MISMATCH_TOAST_ID)
    }
  }, [])

  return (
    // When anchored to the file-options ⋯ button, skip the header-only gap hack.
    <div className={cn("relative flex items-center", hideTrigger && !anchor && "-ml-1")}>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        {!anchor && (
          <AppTooltip content={t("editor.view.settings")}>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("editor.view.settings")}
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
          <PopoverTitle className="sr-only">{t("editor.view.settings")}</PopoverTitle>

          <FieldGroup className="gap-3">
            <SwitchRow
              id="view-show-line-numbers"
              label={t("editor.view.showLineNumbers")}
              checked={lineNumbersEnabled}
              disabled={!fileOpen}
              onCheckedChange={onLineNumbersChange}
            />
            <SwitchRow
              id="view-show-cell-labels"
              label={t("editor.view.showCellLabels")}
              checked={cellLabelsEnabled}
              onCheckedChange={onCellLabelsChange}
            />
            <SwitchRow
              id="view-show-translation-notes"
              label={t("editor.view.showTranslationNotes")}
              checked={tnSidebarEnabled}
              onCheckedChange={onTnSidebarChange}
            />
          </FieldGroup>

          {onFootnoteViewModeChange && (
            <>
              <Separator />
              <div className="flex flex-col gap-2">
                <SectionLabel>{t("editor.footnotes.label")}</SectionLabel>
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
                          {t(option.labelKey)}
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
            <SectionLabel>{t("editor.view.textDirection")}</SectionLabel>
            <DirectionModeRow
              label={t("editor.column.source")}
              disabled={!fileOpen}
              mode={sourceDirectionMode}
              onChange={onSourceDirectionModeChange}
            />
            <DirectionModeRow
              label={t("editor.column.target")}
              disabled={!fileOpen}
              mode={targetDirectionMode}
              onChange={onTargetDirectionModeChange}
            />
          </div>

          <Separator />
          <div className="flex flex-col gap-2">
            <SectionLabel>{t("editor.view.fontSize")}</SectionLabel>
            <FontSizeRow
              label={t("editor.column.source")}
              value={sourceFontSize}
              disabled={!fileOpen}
              onChange={onSourceFontSizeChange}
            />
            <FontSizeRow
              label={t("editor.column.target")}
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
  const t = useT()
  return (
    <div
      className={cn(
        "flex select-none items-center justify-between gap-2 text-sm",
        disabled && "opacity-50",
      )}
    >
      <span>{label}</span>
      <span className="flex items-center gap-1">
        <AppTooltip content={t("editor.view.decreaseFontSize", { side: label.toLowerCase() })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("editor.view.decreaseFontSize", { side: label.toLowerCase() })}
            disabled={disabled || value <= MIN_FONT_SIZE}
            onClick={() => onChange(Math.max(MIN_FONT_SIZE, value - FONT_SIZE_STEP))}
            className="size-5"
          >
            <span className="text-[11px] leading-none select-none">A−</span>
          </Button>
        </AppTooltip>
        <span className="w-9 text-center text-[10px] tabular-nums text-muted-foreground">{value}px</span>
        <AppTooltip content={t("editor.view.increaseFontSize", { side: label.toLowerCase() })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("editor.view.increaseFontSize", { side: label.toLowerCase() })}
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
  const t = useT()
  return (
    <div className={cn("flex flex-col gap-1.5", disabled && "opacity-50")}>
      <span className="text-sm">{label}</span>
      <SegmentTabs<DirectionMode>
        value={mode}
        onValueChange={onChange}
        aria-label={t("editor.view.directionOf", { side: label })}
        listClassName="w-full"
        options={[
          { label: t("editor.view.directionAuto"), value: "auto", disabled },
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
  return { side, forced: mode, detected: summary }
}

function sideLabelKey(side: "source" | "target"): MessageKey {
  return side === "source" ? "editor.column.source" : "editor.column.target"
}

function directionNameKey(direction: TextDirection): MessageKey {
  return direction === "rtl" ? "editor.view.dirRtl" : "editor.view.dirLtr"
}

function detectedDirectionNameKey(direction: TextDirectionSummary): MessageKey {
  if (direction === "mixed") return "editor.view.dirMixed"
  return directionNameKey(direction)
}
