// AQU-1094/1095/1096/1098: the unit inspector.
//
// Docked beside the board rather than laid over it, so the page stays visible
// and interactive: you can click one unit after another, watch a row move to
// Done as you mark it, and walk the list with the arrow keys without ever
// closing anything.
//
// Content ADAPTS TO ACCESS rather than disabling controls. A contributor never
// receives the date picker or the Done button — the values are still readable,
// with one line saying who may change them. Same rule the cell-editing floor
// settled on: no access, nothing renders.

import { useState } from "react"
import { useT, useI18n } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { DatePicker, deadlineStringToDate, dateToDeadlineString } from "@/components/ui/date-picker"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { X, ChevronUp, ChevronDown } from "lucide-react"
import { fmtDeadlineDate } from "@/lib/format-date"
import { formatRelativeTime } from "@/lib/i18n/format"
import { isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
import { planPct, planUnitLabel, planUnitStatus, type PlanUnit } from "@/lib/plan/plan-status"
import type { PlanUnitPatch } from "@/lib/sync/plan"
import { usePlanUnitSections, type PlanSection } from "@/hooks/usePlanUnitSections"
import { PlanStatusPill } from "./PlanStatusPill"
import { PlanBar } from "./PlanBar"
import { usePlanUnitNote } from "./use-plan-note"

/**
 * Mounted with a `key` per unit by its caller, so stepping to another unit
 * remounts rather than carrying the previous one's half-finished confirmation
 * across. That is React's own answer to "reset state when a prop changes", and
 * it beats an effect that writes state during render.
 */
export function PlanInspector({
  unit, now, canPlan, showAudio, projectId, getToken, lane, languageLabel,
  onPatch, onClose, onStep,
}: {
  unit: PlanUnit
  now: number
  /** MAINTAINER+: may set target dates and mark units done. */
  canPlan: boolean
  showAudio: boolean
  projectId: string | null
  /** Mints a project-scoped sync token, for the chapter breakdown. */
  getToken: (() => Promise<string | null>) | null
  lane: string
  /** The language the numbers on screen belong to. */
  languageLabel: string | null
  onPatch: (patch: PlanUnitPatch) => Promise<boolean>
  onClose: () => void
  onStep: (delta: number) => void
}) {
  const t = useT()
  const { locale } = useI18n()
  const [confirmingDone, setConfirmingDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const status = planUnitStatus(unit, now)
  const note = usePlanUnitNote(unit, now)
  const validatedPct = planPct(unit.validatedCount, unit.totalCount)
  const { sections } = usePlanUnitSections({ projectId, unit, getToken, lane })

  // A book breaks into chapters; anything else breaks into sections. The unit
  // itself decides, the same way the board refuses to call every row a book.
  const isBook = isKnownBookCode(unit.sectionKey)
  const sectionsHeadingKey = isBook
    ? "org.projectOverview.plan.chapters"
    : "org.projectOverview.plan.sections"
  const sectionsCountKey = isBook
    ? "org.projectOverview.plan.chapterCount"
    : "org.projectOverview.plan.sectionCount"

  const patch = async (p: Omit<PlanUnitPatch, "fileId" | "sectionKey">) => {
    setBusy(true)
    await onPatch({ fileId: unit.fileId, sectionKey: unit.sectionKey, ...p })
    setBusy(false)
  }

  const markDone = () => {
    setConfirmingDone(false)
    void patch({ done: true })
  }

  // "1,007 cells · 21 chapters · Tok Pisin" — everything that identifies which
  // numbers these are, on one line, so no reader mistakes one lane for another.
  const meta = [
    t("org.projectOverview.plan.cellCount", { count: unit.totalCount }),
    sections.length > 0 ? t(sectionsCountKey as never, { count: sections.length }) : null,
    languageLabel,
  ].filter(Boolean).join(" · ")

  return (
    <aside
      data-testid="plan-inspector"
      aria-label={t("org.projectOverview.plan.inspectorAria", { unit: planUnitLabel(unit) })}
      className="flex h-full min-h-0 flex-col overflow-hidden border-s bg-card"
    >
      <header className="flex items-start justify-between gap-2.5 border-b px-4 py-3.5">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold tracking-tight">{planUnitLabel(unit)}</h3>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground" data-testid="plan-inspector-meta">
            {meta}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="icon-xs" data-testid="plan-inspector-prev"
            title={t("org.projectOverview.plan.previousUnit")} onClick={() => onStep(-1)}>
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" data-testid="plan-inspector-next"
            title={t("org.projectOverview.plan.nextUnit")} onClick={() => onStep(1)}>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" data-testid="plan-inspector-close"
            title={t("common.close")} onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <PlanStatusPill status={status} now={now} />
          {note && (
            <span className="text-[11.5px] text-muted-foreground" data-testid="plan-inspector-note">
              {note}
            </span>
          )}
        </div>

        {/* Target date */}
        <div className="flex flex-col gap-2">
          <Label htmlFor={`plan-target-${unit.fileId}${unit.sectionKey}`}>
            {t("org.projectOverview.plan.targetDate")}
          </Label>
          {canPlan ? (
            <>
              <div className="flex items-center gap-2">
                <DatePicker
                  id={`plan-target-${unit.fileId}${unit.sectionKey}`}
                  value={deadlineStringToDate(unit.targetDate)}
                  placeholder={t("org.projectOverview.plan.noTarget")}
                  disabled={busy}
                  onChange={(d) => void patch({ targetDate: d ? dateToDeadlineString(d) : null })}
                />
                {unit.targetDate && (
                  <Button variant="ghost" size="sm" disabled={busy}
                    data-testid="plan-target-clear"
                    onClick={() => void patch({ targetDate: null })}>
                    {t("common.clear")}
                  </Button>
                )}
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                {t("org.projectOverview.plan.targetVisibleHint")}
              </p>
            </>
          ) : (
            <>
              <p className="text-[13.5px] tabular-nums" data-testid="plan-target-readonly">
                {unit.targetDate
                  ? fmtDeadlineDate(unit.targetDate, now, locale)
                  : t("org.projectOverview.plan.noTargetSet")}
              </p>
              <p className="text-[11.5px] text-muted-foreground">
                {t("org.projectOverview.plan.targetMaintainerOnly")}
              </p>
            </>
          )}
        </div>

        {/* Completion */}
        <div className="flex flex-col gap-2">
          <Label>{t("org.projectOverview.plan.completion")}</Label>
          {unit.doneAt != null ? (
            <>
              <p className="flex items-center gap-2 text-[13.5px] font-medium text-emerald-700 dark:text-emerald-400"
                 data-testid="plan-done-provenance">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                {t("org.projectOverview.plan.markedDoneBy", {
                  date: fmtDeadlineDate(unit.doneAt, now, locale),
                  user: unit.doneBy ?? t("org.projectOverview.plan.aMaintainer"),
                })}
              </p>
              {canPlan && (
                <div>
                  <Button variant="outline" size="sm" disabled={busy}
                    data-testid="plan-unmark-done"
                    onClick={() => void patch({ done: false })}>
                    {t("org.projectOverview.plan.unmarkDone")}
                  </Button>
                </div>
              )}
            </>
          ) : !canPlan ? (
            <p className="text-[13.5px] text-muted-foreground" data-testid="plan-done-readonly">
              {t("org.projectOverview.plan.notMarkedDone")}
            </p>
          ) : confirmingDone ? (
            <>
              {/* Informative, not blocking: Done is a judgment the percentages
                  cannot make, so this acknowledges the mismatch and moves on. */}
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[13px] leading-relaxed"
                 data-testid="plan-done-nudge">
                {t("org.projectOverview.plan.doneBelowFullNudge", { validated: validatedPct })}
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={busy} data-testid="plan-mark-done-anyway" onClick={markDone}>
                  {t("org.projectOverview.plan.markDoneAnyway")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingDone(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={busy} data-testid="plan-mark-done"
                onClick={() => (validatedPct < 100 ? setConfirmingDone(true) : markDone())}>
                {t("org.projectOverview.plan.markDone")}
              </Button>
              <span className="text-[11.5px] text-muted-foreground">
                {t("org.projectOverview.plan.markDoneHint")}
              </span>
            </div>
          )}
        </div>

        {/* Progress */}
        <div className="flex flex-col gap-2">
          <Label>{t("org.projectOverview.plan.progress")}</Label>
          <div className="flex flex-col gap-3">
            <Progress value={planPct(unit.filledCount, unit.totalCount)}>
              <ProgressLabel>{t("org.projectOverview.plan.textTranslated")}</ProgressLabel>
              <ProgressValue />
            </Progress>
            <Progress value={validatedPct}>
              <ProgressLabel>{t("org.projectOverview.plan.textValidated")}</ProgressLabel>
              <ProgressValue />
            </Progress>
            {showAudio && (
              <>
                <Progress value={planPct(unit.audioCount, unit.totalCount)}>
                  <ProgressLabel>{t("org.projectOverview.plan.audioRecorded")}</ProgressLabel>
                  <ProgressValue />
                </Progress>
                <Progress value={planPct(unit.audioValidatedCount, unit.totalCount)}>
                  <ProgressLabel>{t("org.projectOverview.plan.audioValidated")}</ProgressLabel>
                  <ProgressValue />
                </Progress>
              </>
            )}
          </div>
          <p className="text-[11.5px] text-muted-foreground" data-testid="plan-last-activity">
            {unit.lastEditAt
              ? t("org.projectOverview.plan.lastActivity", {
                  when: formatRelativeTime(unit.lastEditAt, locale, now),
                })
              : t("org.projectOverview.plan.noActivity")}
          </p>
        </div>

        {/* Chapters / sections — AQU-1098 */}
        {sections.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="plan-sections">
            <Label>{t(sectionsHeadingKey as never)}</Label>
            <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto pe-1">
              {sections.map((section) => (
                <PlanSectionRow
                  key={section.key}
                  section={section}
                  showAudio={showAudio}
                  translatedAria={t("org.projectOverview.plan.textBarsAria", {
                    translated: planPct(section.filledCount, section.totalCount),
                    validated: planPct(section.validatedCount, section.totalCount),
                  })}
                  audioAria={t("org.projectOverview.plan.audioBarsAria", {
                    recorded: planPct(section.audioCount, section.totalCount),
                    validated: planPct(section.audioValidatedCount, section.totalCount),
                  })}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}

/** One chapter: its number, then the same nested bars the board rows use. */
function PlanSectionRow({ section, showAudio, translatedAria, audioAria }: {
  section: PlanSection
  showAudio: boolean
  translatedAria: string
  audioAria: string
}) {
  return (
    <div className="flex items-center gap-2" data-testid={`plan-section-${section.key}`}>
      <span className="w-6 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">
        {section.label}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <PlanBar
          outer={planPct(section.filledCount, section.totalCount)}
          inner={planPct(section.validatedCount, section.totalCount)}
          tone="text"
          aria={translatedAria}
        />
        {showAudio && (
          <PlanBar
            outer={planPct(section.audioCount, section.totalCount)}
            inner={planPct(section.audioValidatedCount, section.totalCount)}
            tone="audio"
            aria={audioAria}
          />
        )}
      </span>
    </div>
  )
}
