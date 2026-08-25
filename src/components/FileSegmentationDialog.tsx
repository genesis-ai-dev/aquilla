import { useCallback, useEffect, useState, type ReactNode } from "react"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import {
  fetchSegmentation,
  generateSegmentation,
  saveSegmentation,
  type SegmentationSnapshot,
} from "@/lib/contextual/segmentation-api"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/** The three ways a file can be divided. "ai" does not map to a stored
 *  strategy directly: it runs the model pass, which WRITES an explicit
 *  boundary list — so choosing it is an action, not a setting, and the dialog
 *  reports what it found rather than closing silently. */
type Choice = "auto" | "fixed" | "ai"
type EffectivePreview = SegmentationSnapshot["effective"]

interface Props {
  projectId: string
  fileId: string | null
  fileName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** False for roles below PROJECT_LEAD: the dialog reads, but cannot save. */
  canEdit: boolean
}

/**
 * "Segmentation" dialog, opened from a sidebar file row's ⋯ / right-click
 * menu or the editor File options ⋯ (beside Import).
 *
 * Shows how the file is currently divided into passages and lets a project
 * lead change it. The preview is server-computed through the same resolver the
 * autopilot run calls, so what a translator approves here is what the run will
 * use — a preview built from a second, client-side implementation would drift
 * from the real boundaries without anyone noticing.
 */
export function FileSegmentationDialog({
  projectId, fileId, fileName, open, onOpenChange, canEdit,
}: Props) {
  const { t, locale } = useI18n()
  const [snapshot, setSnapshot] = useState<SegmentationSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [generated, setGenerated] = useState<{ passageCount: number; notes: string[] } | null>(null)
  const [choice, setChoice] = useState<Choice>("auto")
  const [size, setSize] = useState("10")
  const [note, setNote] = useState("")
  const [livePreview, setLivePreview] = useState<EffectivePreview | null>(null)
  const [previewDirty, setPreviewDirty] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)

  const num = useCallback((value: number) => formatNumber(value, locale), [locale])

  // Reload on every open: another lead may have changed it, and a stale
  // preview would have a translator approving boundaries that are not there.
  useEffect(() => {
    if (!open || !fileId) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setSaveError(null)
    setGenerated(null)
    setLivePreview(null)
    setPreviewDirty(false)
    fetchSegmentation(projectId, fileId)
      .then((next) => {
        if (cancelled) return
        setSnapshot(next)
        setChoice(next.segmentation?.strategy === "fixed" ? "fixed" : "auto")
        if (next.segmentation?.fixedSize) setSize(String(next.segmentation.fixedSize))
        setNote(next.segmentation?.note ?? "")
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : t("segmentation.loadFailed"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, projectId, fileId, t])

  const limits = snapshot?.limits ?? { minSize: 2, maxSize: 50, maxBoundaries: 2000 }
  const parsedSize = Number.parseInt(size, 10)
  const sizeValid =
    Number.isFinite(parsedSize) && parsedSize >= limits.minSize && parsedSize <= limits.maxSize

  // Auto/fixed preview through the same server resolver the run uses — never
  // a second client-side cut. AI cannot live-preview; that path writes first.
  useEffect(() => {
    if (!open || !fileId || !snapshot?.available || !previewDirty) return
    if (choice === "ai") {
      setLivePreview(null)
      setPreviewLoading(false)
      return
    }
    if (choice === "fixed" && !sizeValid) return
    let cancelled = false
    const delay = choice === "fixed" ? 280 : 0
    setPreviewLoading(true)
    const timer = window.setTimeout(() => {
      fetchSegmentation(
        projectId,
        fileId,
        choice === "fixed" ? { strategy: "fixed", fixedSize: parsedSize } : { strategy: "auto" },
      )
        .then((next) => {
          if (!cancelled) setLivePreview(next.effective)
        })
        .catch(() => {
          /* Keep the last preview; the stored snapshot is still on screen. */
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false)
        })
    }, delay)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, fileId, projectId, snapshot?.available, previewDirty, choice, parsedSize, sizeValid])
  const canSubmit =
    canEdit && !saving && snapshot?.available === true && (choice !== "fixed" || sizeValid)

  /**
   * "ai" runs the pass and REPORTS; the other two save and close.
   *
   * The AI branch deliberately stays open on success: the model just decided
   * where every passage in the file begins, and closing on a spinner would
   * give a translator no chance to see what it did. Reloading the snapshot
   * repaints the preview with the passages it actually stored.
   */
  async function submit(): Promise<void> {
    if (!fileId || !canSubmit) return
    setSaving(true)
    setSaveError(null)
    setGenerated(null)
    try {
      if (choice === "ai") {
        const result = await generateSegmentation(projectId, fileId, note)
        setGenerated({
          passageCount: result.generated.passageCount,
          notes: result.generated.notes,
        })
        setSnapshot(await fetchSegmentation(projectId, fileId))
        setLivePreview(null)
        setPreviewDirty(false)
        return
      }
      await saveSegmentation(projectId, fileId, {
        strategy: choice,
        ...(choice === "fixed" ? { fixedSize: parsedSize } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      onOpenChange(false)
    } catch (err: unknown) {
      setSaveError(
        t("segmentation.saveFailed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setSaving(false)
    }
  }

  // Hoisted out of the JSX: an inline `choice === "fixed"` reads to the i18n
  // lint rule as a user-visible string literal.
  const showSizeInput = choice === "fixed"
  const showNoteInput = choice === "ai"
  const effective = livePreview ?? snapshot?.effective
  const stored = snapshot?.segmentation
  const currentSource =
    livePreview && choice === "fixed"
      ? t("segmentation.sourceFixed", { size: num(parsedSize) })
      : livePreview && choice === "auto"
        ? t("segmentation.sourceAuto")
        : stored?.strategy === "fixed" && stored.fixedSize
          ? t("segmentation.sourceFixed", { size: num(stored.fixedSize) })
          : stored?.strategy === "explicit"
            ? t("segmentation.sourceExplicit")
            : t("segmentation.sourceAuto")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate pe-8">{t("segmentation.title")}</DialogTitle>
          {fileName ? (
            <p className="truncate text-sm text-muted-foreground">{fileName}</p>
          ) : null}
          <DialogDescription>{t("segmentation.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5">
          {loading && (
            <div className="flex justify-center py-6"><Spinner /></div>
          )}
          {!loading && loadError && (
            <p className="text-sm text-destructive">{loadError}</p>
          )}
          {!loading && !loadError && snapshot && !snapshot.available && (
            <p className="text-sm text-muted-foreground">{t("segmentation.unavailable")}</p>
          )}

          {!loading && !loadError && snapshot?.available && effective && (
            <>
              <section className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">
                  {t("segmentation.currentHeading")}
                </h3>
                <p className="text-sm">
                  {t("segmentation.currentSummary", {
                    spanCount: num(effective.spanCount),
                    cellCount: num(effective.cellCount),
                  })}
                </p>
                <p className="text-xs text-muted-foreground">{currentSource}</p>
                {stored?.staleSince && !livePreview && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    {t("segmentation.staleWarning")}
                  </p>
                )}
              </section>

              {effective.spans.length > 0 && (
                <section className="flex flex-col gap-1.5">
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    {t("common.preview")}
                    {previewLoading ? <Spinner className="size-3.5" /> : null}
                  </h3>
                  <ul className="max-h-40 overflow-y-auto rounded-lg border bg-muted/30 text-sm">
                    {effective.spans.map((span) => (
                      <li
                        key={`${span.startCellId}:${span.endCellId}`}
                        className="flex items-start justify-between gap-3 border-b border-border/50 px-2.5 py-1.5 last:border-b-0"
                      >
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate">{span.label || span.startCellId}</span>
                          {span.excerpt ? (
                            <span className="truncate text-xs text-muted-foreground">{span.excerpt}</span>
                          ) : null}
                        </span>
                        <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                          {t("segmentation.previewSpanCells", { count: num(span.cellCount) })}
                        </span>
                      </li>
                    ))}
                    {effective.truncated && (
                      <li className="px-2.5 py-1.5 text-xs text-muted-foreground">
                        {t("segmentation.previewTruncated", {
                          count: num(effective.spanCount - effective.spans.length),
                        })}
                      </li>
                    )}
                  </ul>
                </section>
              )}

              <FieldSet className="min-w-0">
                <FieldLegend variant="label" className="p-0">
                  {t("segmentation.strategyHeading")}
                </FieldLegend>
                <RadioGroup
                  name="segmentation-strategy"
                  value={choice}
                  onValueChange={(value) => {
                    setChoice(value as Choice)
                    setPreviewDirty(true)
                  }}
                  className="flex flex-col gap-0.5"
                >
                  <StrategyOption
                    value="auto"
                    selected={choice === "auto"}
                    disabled={!canEdit}
                    label={t("segmentation.autoLabel")}
                    help={t("segmentation.autoHelp")}
                  />

                  {/* The number input is a SIBLING of the option's label, not
                      a child: nesting one label inside another is invalid
                      markup, and it silently detaches the input from its own
                      label for screen readers and for label-based queries. */}
                  <StrategyOption
                    value="fixed"
                    selected={choice === "fixed"}
                    disabled={!canEdit}
                    label={t("segmentation.fixedLabel")}
                    help={t("segmentation.fixedHelp")}
                  >
                    {showSizeInput && (
                      <Field className="ps-8 pe-2 pb-1.5">
                        <FieldLabel htmlFor="segmentation-size">
                          {t("segmentation.fixedInputLabel")}
                        </FieldLabel>
                        <Input
                          id="segmentation-size"
                          type="number"
                          inputMode="numeric"
                          min={limits.minSize}
                          max={limits.maxSize}
                          value={size}
                          disabled={!canEdit}
                          onChange={(e) => {
                            setSize(e.target.value)
                            setPreviewDirty(true)
                          }}
                          className="w-28"
                          aria-invalid={!sizeValid}
                        />
                        <FieldDescription>
                          {t("segmentation.fixedRange", {
                            min: num(limits.minSize),
                            max: num(limits.maxSize),
                          })}
                        </FieldDescription>
                      </Field>
                    )}
                  </StrategyOption>

                  <StrategyOption
                    value="ai"
                    selected={choice === "ai"}
                    disabled={!canEdit}
                    label={t("segmentation.aiLabel")}
                    help={t("segmentation.aiHelp")}
                    extraHelp={t("segmentation.aiSlowHint")}
                  >
                    {showNoteInput && (
                      <Field className="ps-8 pe-2 pb-1.5">
                        <FieldLabel htmlFor="segmentation-note">
                          {t("segmentation.aiNoteLabel")}
                        </FieldLabel>
                        <Textarea
                          id="segmentation-note"
                          rows={2}
                          value={note}
                          disabled={!canEdit}
                          placeholder={t("segmentation.aiNotePlaceholder")}
                          onChange={(e) => setNote(e.target.value)}
                        />
                      </Field>
                    )}
                  </StrategyOption>
                </RadioGroup>
              </FieldSet>

              {!canEdit && (
                <p className="text-xs text-muted-foreground">{t("segmentation.readOnly")}</p>
              )}
              {generated && (
                <div className="flex flex-col gap-1">
                  <p className="text-sm">
                    {t("segmentation.aiDone", { count: num(generated.passageCount) })}
                  </p>
                  {generated.notes.length > 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                      {t("segmentation.aiPartial", { notes: generated.notes.join("; ") })}
                    </p>
                  )}
                </div>
              )}
              {saveError && <p className="text-sm text-destructive">{saveError}</p>}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => { void submit() }} disabled={!canSubmit}>
            {saving
              ? choice === "ai"
                ? t("segmentation.aiRunning")
                : t("common.saving")
              : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StrategyOption({
  value,
  selected,
  disabled,
  label,
  help,
  extraHelp,
  children,
}: {
  value: Choice
  selected: boolean
  disabled: boolean
  label: string
  help: string
  extraHelp?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col">
      <label
        className={cn(
          "flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors",
          selected ? "bg-muted/60" : "hover:bg-accent/40",
          disabled && "opacity-50",
        )}
      >
        <RadioGroupItem value={value} className="mt-0.5 shrink-0" disabled={disabled} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium leading-tight">{label}</span>
          <span className="text-xs leading-relaxed text-muted-foreground">{help}</span>
          {extraHelp ? (
            <span className="text-xs leading-relaxed text-muted-foreground">{extraHelp}</span>
          ) : null}
        </span>
      </label>
      {children}
    </div>
  )
}
