import { useCallback, useEffect, useState } from "react"
import { Sparkles } from "lucide-react"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import {
  fetchSegmentation,
  generateSegmentation,
  saveSegmentation,
  type SegmentationSnapshot,
} from "@/lib/contextual/segmentation-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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

/** The three ways a file can be divided. "ai" does not map to a stored
 *  strategy directly: it runs the model pass, which WRITES an explicit
 *  boundary list — so choosing it is an action, not a setting, and the dialog
 *  reports what it found rather than closing silently. */
type Choice = "auto" | "fixed" | "ai"

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
 * "Segmentation" dialog, opened from a sidebar file row's ⋯ / right-click menu.
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
  const effective = snapshot?.effective
  const stored = snapshot?.segmentation
  const currentSource =
    stored?.strategy === "fixed" && stored.fixedSize
      ? t("segmentation.sourceFixed", { size: num(stored.fixedSize) })
      : stored?.strategy === "explicit"
        ? t("segmentation.sourceExplicit")
        : t("segmentation.sourceAuto")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate pe-8">{t("segmentation.title")}</DialogTitle>
          <DialogDescription>{t("segmentation.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <p className="sr-only">{fileName}</p>

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
              <section className="space-y-1">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("segmentation.currentHeading")}
                </h3>
                <p className="text-sm">
                  {t("segmentation.currentSummary", {
                    spanCount: num(effective.spanCount),
                    cellCount: num(effective.cellCount),
                  })}
                </p>
                <p className="text-xs text-muted-foreground">{currentSource}</p>
                {stored?.staleSince && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    {t("segmentation.staleWarning")}
                  </p>
                )}
              </section>

              {effective.spans.length > 0 && (
                <section className="space-y-1">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("common.preview")}
                  </h3>
                  <ul className="max-h-40 overflow-y-auto rounded-md border border-border/60 text-[13px]">
                    {effective.spans.map((span) => (
                      <li
                        key={`${span.startCellId}:${span.endCellId}`}
                        className="flex items-baseline justify-between gap-3 border-b border-border/40 px-2 py-1 last:border-b-0"
                      >
                        <span className="min-w-0 truncate">{span.label || span.startCellId}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {t("segmentation.previewSpanCells", { count: num(span.cellCount) })}
                        </span>
                      </li>
                    ))}
                    {effective.truncated && (
                      <li className="px-2 py-1 text-muted-foreground">
                        {t("segmentation.previewTruncated", {
                          count: num(effective.spanCount - effective.spans.length),
                        })}
                      </li>
                    )}
                  </ul>
                </section>
              )}

              <section className="space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("segmentation.strategyHeading")}
                </h3>
                <RadioGroup
                  name="segmentation-strategy"
                  value={choice}
                  onValueChange={(value) => setChoice(value as Choice)}
                  className="flex flex-col gap-3"
                >
                  <label className="flex items-start gap-2 text-sm">
                    <RadioGroupItem value="auto" className="mt-1" disabled={!canEdit} />
                    <span>
                      <span className="font-medium">{t("segmentation.autoLabel")}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t("segmentation.autoHelp")}
                      </span>
                    </span>
                  </label>

                  {/* The number input is a SIBLING of the option's label, not
                      a child: nesting one label inside another is invalid
                      markup, and it silently detaches the input from its own
                      label for screen readers and for label-based queries. */}
                  <div className="space-y-2">
                    <label className="flex items-start gap-2 text-sm">
                      <RadioGroupItem value="fixed" className="mt-1" disabled={!canEdit} />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{t("segmentation.fixedLabel")}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t("segmentation.fixedHelp")}
                        </span>
                      </span>
                    </label>
                    {showSizeInput && (
                      <div className="space-y-1 ps-6">
                        <Label htmlFor="segmentation-size" className="text-xs">
                          {t("segmentation.fixedInputLabel")}
                        </Label>
                        <Input
                          id="segmentation-size"
                          type="number"
                          inputMode="numeric"
                          min={limits.minSize}
                          max={limits.maxSize}
                          value={size}
                          disabled={!canEdit}
                          onChange={(e) => setSize(e.target.value)}
                          className="w-28"
                          aria-invalid={!sizeValid}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("segmentation.fixedRange", {
                            min: num(limits.minSize),
                            max: num(limits.maxSize),
                          })}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label className="flex items-start gap-2 text-sm">
                      <RadioGroupItem value="ai" className="mt-1" disabled={!canEdit} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 font-medium">
                          <Sparkles className="h-3.5 w-3.5" aria-hidden />
                          {t("segmentation.aiLabel")}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t("segmentation.aiHelp")}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t("segmentation.aiSlowHint")}
                        </span>
                      </span>
                    </label>
                    <div className="space-y-1 ps-6">
                      <Label htmlFor="segmentation-note" className="text-xs">
                        {t("segmentation.aiNoteLabel")}
                      </Label>
                      <Textarea
                        id="segmentation-note"
                        rows={2}
                        value={note}
                        disabled={!canEdit}
                        placeholder={t("segmentation.aiNotePlaceholder")}
                        onChange={(e) => setNote(e.target.value)}
                      />
                    </div>
                  </div>
                </RadioGroup>
              </section>

              {!canEdit && (
                <p className="text-xs text-muted-foreground">{t("segmentation.readOnly")}</p>
              )}
              {generated && (
                <div className="space-y-1">
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
