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
//
// AQU-1278 re-ordered the panel around ONE question: what is left. Progress,
// who is working on it, and the chapter grid come first; the planning controls
// — target date and the Done mark — moved under a divider at the bottom. They
// are the things you touch once and read never, and they were pushing the
// shortfall below the fold on a short panel.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useT, useI18n } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { DatePicker, deadlineStringToDate, dateToDeadlineString } from "@/components/ui/date-picker"
import { X, ChevronUp, ChevronDown, ArrowRight } from "lucide-react"
import { fmtDeadlineDate } from "@/lib/format-date"
import { formatRelativeTime } from "@/lib/i18n/format"
import { isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
import {
  planPct, planShortfallParts, planUnitIsNearlyComplete, planUnitLabel, planUnitNote,
  planUnitShortfall, planUnitStatus, type PlanUnit,
} from "@/lib/plan/plan-status"
import { classifyPlanSection, isMediaFileKind, numberedBookCodes } from "@/lib/plan/plan-section"
import type { PlanUnitPatch } from "@/lib/sync/plan"
import { usePlanUnitSections, type PlanSection } from "@/hooks/usePlanUnitSections"
import { PlanStatusPill } from "./PlanStatusPill"
import { PlanBar } from "./PlanBar"
import { PlanChapterGrid, PlanGridLegend, planSectionShortfall } from "./PlanChapterGrid"
import { PLAN_TONE } from "./plan-tone"
import { usePlanStatusNote } from "./use-plan-note"
import { useSectionVerses, type SectionVersesState } from "./use-section-verses"
import { shortVerses, verseChipLabel, verseChipSplit, verseChipsThatFit } from "./verse-chips"

/**
 * Mounted with a `key` per unit by its caller, so stepping to another unit
 * remounts rather than carrying the previous one's half-finished confirmation
 * across. That is React's own answer to "reset state when a prop changes", and
 * it beats an effect that writes state during render.
 */
export function PlanInspector({
  unit, now, canPlan, showAudio, projectId, getToken, lane, languageLabel, laneCount,
  assignments, audioFiles, onPatch, onClose, onStep, onGoToFirstOpen, onOpenCell,
}: {
  unit: PlanUnit
  now: number
  /**
   * Which FILES carry recordings, from `audioFileIds` over the WHOLE board.
   * Audio expectation is a fact about a file, not about one book inside it, so
   * this panel must judge it the same way the row above it does or the two will
   * disagree about the same unit. Absent, the unit's own count stands in.
   */
  audioFiles?: ReadonlySet<string>
  /** MAINTAINER+: may set target dates and mark units done. */
  canPlan: boolean
  showAudio: boolean
  projectId: string | null
  /** Mints a project-scoped sync token, for the chapter breakdown. */
  getToken: (() => Promise<string | null>) | null
  lane: string
  /** The language the numbers on screen belong to. */
  languageLabel: string | null
  /**
   * AQU-1278: how many target languages this project carries. Above one, the
   * audio bar gets a note saying it is the same on every tab — see the note's
   * own comment for why that is worth a line.
   */
  laneCount?: number
  /**
   * AQU-1278: the per-assignment block, rendered between Progress and Chapters.
   *
   * A SLOT, not a component. Who is assigned to what comes from the auth
   * worker's per-unit assignment read, which the inspector has no business
   * fetching — it already takes a token-minting function and a project id for
   * the chapter breakdown, and a second fetch of a different shape from a
   * different worker belongs to a component of its own. Whatever fills this
   * renders its own heading; the inspector only leaves the hole and the gap
   * around it.
   */
  assignments?: ReactNode
  onPatch: (patch: PlanUnitPatch) => Promise<boolean>
  onClose: () => void
  onStep: (delta: number) => void
  /**
   * AQU-1278: the one link out of the plan and into the editor, landing on the
   * first cell that is actually missing something.
   *
   * WHICH CELL THAT IS BELONGS TO ProjectOverview, not here. The answer needs
   * the chapter-detail response's `cellId` and the editor's own routing, both
   * of which live upstairs; the inspector knows only that a unit has
   * untranslated cells before it has unvalidated ones, which is all this
   * callback carries. Absent, no link renders — nothing to navigate to.
   */
  onGoToFirstOpen?: (kind: "untranslated" | "unvalidated") => void
  /**
   * AQU-1278: open the editor at ONE cell, from a verse chip in the chapter
   * card. Same division of labour as `onGoToFirstOpen` — this panel knows which
   * cell was clicked and nothing about where the editor lives. Absent, the
   * chips still draw (they say which verses are short, which is worth
   * something on its own) and simply do nothing when pressed.
   */
  onOpenCell?: (cellId: string) => void
}) {
  const t = useT()
  const { locale } = useI18n()
  const [confirmingDone, setConfirmingDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const status = planUnitStatus(unit, now, audioFiles)
  const note = usePlanStatusNote(unit, now, audioFiles)
  // AQU-1278: which note this IS, so the status line can drop the one the
  // Target date section below already answers. Masked rather than skipped —
  // `usePlanStatusNote` is a hook and cannot be called conditionally.
  const noteKind = planUnitNote(unit, now, audioFiles)?.kind ?? null
  const validatedPct = planPct(unit.validatedCount, unit.totalCount)
  const { sections, loading, error } = usePlanUnitSections({ projectId, unit, getToken, lane })

  // AQU-1278. `audioFiles` comes from the board, which computes it over every
  // unit: whether audio is EXPECTED is a fact about the FILE, not about this
  // one book. Judging it here from `unit.audioCount` alone would put a
  // text-only book inside a dubbed file at "nothing left" in this panel while
  // the board — counting the recordings it is missing — still calls it In
  // progress, and the two would sit six inches apart saying different things.
  //
  // Absent (a lone inspector in a test, say) the vocabulary falls back to the
  // unit's own count, which is the right answer when there is no wider list to
  // consult.
  const hasAudio = audioFiles ? audioFiles.has(unit.fileId) : unit.audioCount > 0
  const shortfall = planUnitShortfall(unit, hasAudio)
  // Not `status === "nearly_complete"`: a unit that is ALSO overdue is filed
  // under Overdue, and it is precisely the row that needs its shortfall said
  // out loud. `planUnitIsNearlyComplete` asks the same question with the date
  // stripped, so the row and this panel cannot drift apart.
  const nearlyComplete = planUnitIsNearlyComplete(unit, now, audioFiles)

  // A book breaks into chapters; anything else breaks into sections. The unit
  // itself decides, the same way the board refuses to call every row a book.
  const isBook = isKnownBookCode(unit.sectionKey)
  const sectionsHeadingKey = isBook
    ? "org.projectOverview.plan.chapters"
    : "org.projectOverview.plan.sections"
  const sectionsCountKey = isBook
    ? "org.projectOverview.plan.chapterCount"
    : "org.projectOverview.plan.sectionCount"

  // Which chapter's own bars are open under the grid. Nothing by default: the
  // grid is the summary, and a reader asks for one chapter at a time.
  const [openSectionKey, setOpenSectionKey] = useState<string | null>(null)
  const openSection = sections.find((s) => s.key === openSectionKey) ?? null

  // AQU-1278: that chapter's verses, fetched on the click that opened it and
  // never before — `cells.canonical_ref` is unindexed, so each of these is a
  // full-file scan and a grid that prefetched its fifty tiles would be fifty.
  const sectionVerses = useSectionVerses({ projectId, fileId: unit.fileId, getToken, lane })
  const openSectionTitle = (() => {
    if (!openSection) return ""
    const numbered = numberedBookCodes(sections.map((s) => s.key))
    const kind = classifyPlanSection(openSection.key, numbered)
    // A numbered chapter — and a one-chapter book, which IS chapter 1 — names
    // itself that way. Front matter and a document's own sections keep the
    // names they have; "Chapter Scene 4" would invent one that does not exist.
    return kind.kind === "chapter"
      ? t("org.projectOverview.plan.chapterTitle", { chapter: kind.n })
      : openSection.key
  })()
  const shortChapters = sections.filter(
    // `hasAudio`, not `showAudio`. showAudio is a PROJECT-wide question — does
    // this project track audio at all, and therefore should an audio bar be
    // drawn — and answering the per-chapter one with it counts every chapter of
    // a text-only book as short by all its takes. The panel's own status is
    // judged per FILE two dozen lines up; these two numbers sit on the same
    // screen and must be asked the same question.
    (s) => planSectionShortfall(s, hasAudio).worst > 0,
  ).length

  // `usePlanUnitSections` starts at `loading: false` and only flips it true
  // inside its own effect, so a unit's FIRST render is indistinguishable from a
  // finished read that found nothing — which is exactly the state that prints
  // "this file's sections are time ranges". Waiting for one effect pass keeps
  // that line off the screen for the frame before the fetch even starts.
  //
  // The disable below is the point of the thing rather than a wart on it: "one
  // effect pass has happened" is a fact only an effect can report, and the rule
  // is warning about exactly the cascading render this wants.
  const [asked, setAsked] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAsked(true)
  }, [])
  const breakdownReadable = projectId != null && getToken != null
  const showBreakdown = sections.length > 0 || (breakdownReadable && asked && !loading && !error)

  // A rejected write used to roll back in silence: the optimistic value
  // appeared, the server refused it, the row snapped back, and nothing said
  // why. Setting a date is cheap to retry — but only if you know it failed.
  const [failed, setFailed] = useState(false)
  const patch = async (p: Omit<PlanUnitPatch, "fileId" | "sectionKey">) => {
    setBusy(true)
    setFailed(false)
    const ok = await onPatch({ fileId: unit.fileId, sectionKey: unit.sectionKey, ...p })
    setFailed(!ok)
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

  // ONE LINK, NEVER TWO. Translation leads validation for the reason
  // `planShortfallParts` gives: a cell nobody has written cannot be validated,
  // so a link to the first unvalidated cell in a unit that still has blanks
  // names a queue blocked on the other one. With nothing outstanding in either,
  // there is no cell to land on and no link — a unit can be nearly complete on
  // its text and still short on audio, and "go to first unvalidated" would then
  // scroll the editor to nothing.
  const openKind: "untranslated" | "unvalidated" | null =
    shortfall.toTranslate > 0 ? "untranslated" : shortfall.toValidate > 0 ? "unvalidated" : null

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
        {failed && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px]"
             role="alert" data-testid="plan-patch-failed">
            {t("org.projectOverview.plan.saveFailed")}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <PlanStatusPill status={status} now={now} />
          {/* AQU-1278: LAST ACTIVITY sits beside the pill, where the mockup has
              it — the two together are the one-line answer to "how is this
              going". It used to hang under the bars, and the slot here carried
              "no target date" instead: four words the Target date section two
              inches below says for itself, on every undated unit, forever. */}
          <span className="text-[11.5px] text-muted-foreground" data-testid="plan-last-activity">
            {unit.lastEditAt
              ? t("org.projectOverview.plan.lastActivity", {
                  when: formatRelativeTime(unit.lastEditAt, locale, now),
                })
              : t("org.projectOverview.plan.noActivity")}
          </span>
          {note && noteKind !== "no_target" && (
            <span className="text-[11.5px] text-muted-foreground" data-testid="plan-inspector-note">
              {note}
            </span>
          )}
        </div>

        {/* Progress — the same two bars the row draws, with room to breathe. */}
        <div className="flex flex-col gap-2">
          <Label>{t("org.projectOverview.plan.progress")}</Label>
          <div className="flex flex-col gap-2" data-testid="plan-inspector-bars">
            <PlanBar
              label={t("org.projectOverview.plan.textBarLabel")}
              outer={planPct(unit.filledCount, unit.totalCount)}
              inner={validatedPct}
              tone="text"
              aria={t("org.projectOverview.plan.textBarsAria", {
                translated: planPct(unit.filledCount, unit.totalCount),
                validated: validatedPct,
              })}
            />
            {showAudio && (
              <PlanBar
                label={t("org.projectOverview.plan.audioBarLabel")}
                outer={planPct(unit.audioCount, unit.totalCount)}
                inner={planPct(unit.audioValidatedCount, unit.totalCount)}
                tone="audio"
                aria={t("org.projectOverview.plan.audioBarsAria", {
                  recorded: planPct(unit.audioCount, unit.totalCount),
                  validated: planPct(unit.audioValidatedCount, unit.totalCount),
                })}
              />
            )}
            {/* AQU-1278. A recording hangs off the FILE, not off a target
                language, so the audio bar reads identically on every lane tab
                while the text bar moves. A manager flipping between two
                languages and seeing one bar frozen assumes a stuck filter; this
                says it is the truth instead of leaving them to wonder. Set under
                the bar rather than beside it: the panel is barely three hundred
                pixels wide and an inline note would squeeze the track past the
                52px `PlanBar` refuses to go below. */}
            {/* Per FILE, like the tiles: under an empty bar on a text-only book
                the note explained numbers that were not there. */}
            {hasAudio && (laneCount ?? 1) > 1 && (
              <p className="ps-8 text-[11px] text-muted-foreground" data-testid="plan-audio-shared-note">
                {t("org.projectOverview.plan.audioSharedAcrossLanes")}
              </p>
            )}
          </div>
        </div>

        {/* Chapters / sections — AQU-1098, regridded by AQU-1278 */}
        {showBreakdown && (
          <div className="flex flex-col gap-2" data-testid="plan-sections">
            {/* The legend belongs UP HERE, not under the grid: beneath it, it
                competed with the summary line directly below for the same
                glance, and the summary is the one that changes. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>{t(sectionsHeadingKey as never)}</Label>
              <PlanGridLegend showAudio={hasAudio} />
            </div>
            <PlanChapterGrid
              sections={sections}
              showAudio={hasAudio}
              nearlyComplete={nearlyComplete}
              mediaFile={isMediaFileKind((unit as { fileKind?: string | null }).fileKind)}
              selectedKey={openSectionKey}
              onSelect={(key) =>
                setOpenSectionKey((open) => {
                  if (open === key) return null
                  // The fetch rides the click that opens the chapter, not the
                  // render that follows it — see `useSectionVerses`.
                  sectionVerses.load(key)
                  return key
                })
              }
            />

            {sections.length > 0 && (
              <div
                className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1 text-[11.5px]"
                data-testid="plan-grid-summary"
              >
                {/* ONE of the two, never both. "3 chapters short" and "47 of 50
                    complete" are the same fact counted from opposite ends, and
                    a line carrying both made a reader do the subtraction to
                    check they agreed. What is left wins while anything is left;
                    the complete line takes over when nothing is, where it is
                    the more direct way to say the book is finished. */}
                {shortChapters > 0 ? (
                  <span className="font-medium text-foreground">
                    {t("org.projectOverview.plan.chaptersShort", { count: shortChapters })}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {t("org.projectOverview.plan.chaptersComplete", {
                      done: sections.length,
                      total: sections.length,
                    })}
                  </span>
                )}

                {/* NEARLY COMPLETE ONLY — and so are the grid's count badges. A
                    unit with ninety chapters to go gets no link, on the grounds
                    that "first outstanding cell" is not a useful place to stand
                    when nearly everything is outstanding; you open the file,
                    not a cell. THIS IS FLAGGED FOR RE-CONFIRMATION AT BUILD
                    REVIEW: it is the one rule in AQU-1278 that withholds
                    something from the majority of units, and if the answer
                    changes it changes here and in the `nearlyComplete` prop
                    passed to the grid, nowhere else.
                    It shares the summary's line, right-aligned, because the
                    two belong together: how much is left, and the way to it. */}
                {nearlyComplete && openKind != null && onGoToFirstOpen && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto gap-1 p-0 text-[12px]"
                    data-testid="plan-go-to-first-open"
                    onClick={() => onGoToFirstOpen(openKind)}
                  >
                    {t(openKind === "untranslated"
                      ? "org.projectOverview.plan.goToFirstUntranslated"
                      : "org.projectOverview.plan.goToFirstUnvalidated")}
                    <ArrowRight className="h-3 w-3" aria-hidden />
                  </Button>
                )}
              </div>
            )}

            {/* One chapter, opened from the grid: the same nested bars the unit
                itself draws, so the part is measured exactly like the whole. */}
            {openSection && (
              <PlanChapterCard
                section={openSection}
                title={openSectionTitle}
                hasAudio={hasAudio}
                verses={sectionVerses.get(openSection.key)}
                onOpenCell={onOpenCell}
              />
            )}
          </div>
        )}

        {/* Everything above answers "how is this going". Below the divider is
            where a manager CHANGES something: who is on it, when it is due,
            and whether it is done. AQU-1278 moved "Assigned to" down here from
            between Progress and Chapters — it was pushing the chapter grid, the
            thing this panel exists for, below the fold on a short window. */}
        <div className="flex flex-col gap-5 border-t pt-5">
          {/* AQU-1278: who has been given which slice of this unit. Filled from
              above — see the `assignments` prop. */}
          {assignments}

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
              <>
                {/* AQU-1278: nothing outstanding and nobody has said so. The
                    nudge sits DIRECTLY ABOVE the button rather than beside it,
                    because it is the reason to press it — the hint beside the
                    button says what the button does, which is a different job. */}
                {shortfall.worst === 0 && unit.totalCount > 0 && (
                  <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[13px]"
                     data-testid="plan-nothing-left">
                    {t("org.projectOverview.plan.nothingLeft")}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={busy} data-testid="plan-mark-done"
                    onClick={() => (validatedPct < 100 ? setConfirmingDone(true) : markDone())}>
                    {t("org.projectOverview.plan.markDone")}
                  </Button>
                  <span className="text-[11.5px] text-muted-foreground">
                    {t("org.projectOverview.plan.markDoneHint")}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}

/**
 * One chapter, opened from the grid: the same nested bars the unit itself
 * draws — so the part is measured exactly like the whole — plus a chip per
 * outstanding verse, which is the only place on this panel that turns "three
 * cells short" into somewhere to click.
 *
 * The bars read in COUNTS here rather than percentages. At chapter grain
 * "20/18" is two cells a manager can go and fix, where "100/90%" is those two
 * cells rounded into a shrug.
 */
function PlanChapterCard({
  section, title, hasAudio, verses, onOpenCell,
}: {
  section: PlanSection
  /** "Chapter 12", or a named section's own label. */
  title: string
  hasAudio: boolean
  verses: SectionVersesState | undefined
  onOpenCell?: (cellId: string) => void
}) {
  const t = useT()
  const rowRef = useRef<HTMLDivElement>(null)
  const capacity = useChipRowCapacity(rowRef)

  const shortfall = planSectionShortfall(section, hasAudio)
  // Which queue this chapter is in, and therefore which verses the chips list.
  // `planShortfallParts` has already ordered the terms worst-first with
  // translation ahead of validation, so its first term IS the lead.
  const lead = planShortfallParts(shortfall)[0]
  const outstandingLabel = lead
    ? t(
        (lead.kind === "translate"
          ? "org.projectOverview.plan.chapterCellsUntranslated"
          : lead.kind === "validate"
            ? "org.projectOverview.plan.chapterCellsUnvalidated"
            : "org.projectOverview.plan.chapterTakesUnrecorded") as never,
        { count: lead.count },
      )
    : null

  // Chips only exist for the two TEXT queues: the verse detail carries `filled`
  // and `validated` and nothing about audio, so a chapter short on takes alone
  // has no per-cell answer to give and says so by showing no chips at all.
  const chipLead: "untranslated" | "unvalidated" | null =
    lead?.kind === "translate" ? "untranslated" : lead?.kind === "validate" ? "unvalidated" : null
  const short = verses?.status === "ready" && chipLead
    ? shortVerses(verses.verses, chipLead)
    : []
  const { shown, overflow } = verseChipSplit(short.length, capacity)

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border bg-muted/40 px-2.5 py-2"
      data-testid="plan-chapter-detail"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-semibold" data-testid="plan-chapter-detail-title">
          {title}
        </span>
        {outstandingLabel && (
          <span
            className="text-[11px] text-muted-foreground"
            data-testid="plan-chapter-detail-left"
          >
            {outstandingLabel}
          </span>
        )}
      </div>
      <PlanBar
        label={t("org.projectOverview.plan.textBarLabel")}
        outer={planPct(section.filledCount, section.totalCount)}
        inner={planPct(section.validatedCount, section.totalCount)}
        tone="text"
        aria={t("org.projectOverview.plan.textBarsAria", {
          translated: planPct(section.filledCount, section.totalCount),
          validated: planPct(section.validatedCount, section.totalCount),
        })}
        readout={`${section.totalCount}/${section.validatedCount}`}
      />
      {hasAudio && (
        <PlanBar
          label={t("org.projectOverview.plan.audioBarLabel")}
          outer={planPct(section.audioCount, section.totalCount)}
          inner={planPct(section.audioValidatedCount, section.totalCount)}
          tone="audio"
          aria={t("org.projectOverview.plan.audioBarsAria", {
            recorded: planPct(section.audioCount, section.totalCount),
            validated: planPct(section.audioValidatedCount, section.totalCount),
          })}
          readout={`${section.totalCount}/${section.audioCount}`}
        />
      )}
      {/* ONE ROW, NEVER TWO. Fixed-width chips and a measured capacity, so the
          card's height never depends on how badly a chapter is doing. What
          does not fit folds into a count rather than wrapping. */}
      {short.length > 0 && (
        <div
          ref={rowRef}
          className="flex gap-1 overflow-hidden whitespace-nowrap pt-0.5"
          data-testid="plan-chapter-verses"
        >
          {short.slice(0, shown).map((v) => (
            <button
              key={v.cellId}
              type="button"
              data-testid={`plan-verse-chip-${v.cellId}`}
              // Text in the STATUS azure: `text-primary` is the pale accent
              // tuned for button fills, and on a chip this small it washed out.
              className={`h-6 w-[46px] shrink-0 rounded-full border border-primary/35 bg-primary/10 text-[11.5px] font-medium tabular-nums transition-colors hover:bg-primary/20 ${PLAN_TONE.nearly_complete.text}`}
              onClick={() => onOpenCell?.(v.cellId)}
            >
              {verseChipLabel(v.ref, section.key)}
            </button>
          ))}
          {overflow > 0 && (
            <span
              data-testid="plan-verse-more"
              aria-label={t("org.projectOverview.plan.moreShortVerses", { count: overflow })}
              className="flex h-6 w-[46px] shrink-0 items-center justify-center rounded-full bg-muted text-[11.5px] font-medium tabular-nums text-muted-foreground"
            >
              +{overflow}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * How many fixed-width chips the verse row can hold.
 *
 * Starts at Infinity so the row draws every chip until something is measured:
 * starting at zero would flash a bare "+7" on every open, and under happy-dom —
 * which has no ResizeObserver and reports every width as zero — the chips would
 * never render at all and could never be asserted on. The arithmetic itself is
 * tested directly in `verse-chips.test.ts`, where a width can be supplied.
 */
function useChipRowCapacity(ref: RefObject<HTMLElement | null>): number {
  const [capacity, setCapacity] = useState(Number.POSITIVE_INFINITY)
  useLayoutEffect(() => {
    const row = ref.current
    if (!row) return
    const measure = () => setCapacity(verseChipsThatFit(row.clientWidth))
    measure()
    if (typeof ResizeObserver === "undefined") return // happy-dom
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [ref])
  return capacity
}
