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
import { AppTooltip } from "@/components/ui/tooltip"
import { fmtDeadlineDate } from "@/lib/format-date"
import { formatRelativeTime } from "@/lib/i18n/format"
import { isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
import {
  planAudioTotal, planOpenKind, planPct, planShortfallParts, planUnitExpectsAudio,
  planUnitIsNearlyComplete, planUnitLabel, planUnitNote,
  planUnitShortfall, planUnitStatus, type PlanOpenKind, type PlanUnit,
} from "@/lib/plan/plan-status"
import { classifyPlanSection, numberedBookCodes } from "@/lib/plan/plan-section"
import type { PlanUnitPatch } from "@/lib/sync/plan"
import { usePlanUnitSections, type PlanSection } from "@/hooks/usePlanUnitSections"
import { PlanStatusPill } from "./PlanStatusPill"
import { PlanBar } from "./PlanBar"
import { PlanChapterGrid, PlanGridLegend, planSectionShortfall } from "./PlanChapterGrid"
import { PLAN_TONE } from "./plan-tone"
import { GO_TO_FIRST_KEY, usePlanReadoutTips, usePlanShortfallText, usePlanStatusNote } from "./use-plan-note"
import { useSectionVerses, type SectionVersesState } from "./use-section-verses"
import { shortVerses, verseChipLabel } from "./verse-chips"

/**
 * Mounted with a `key` per unit by its caller, so stepping to another unit
 * remounts rather than carrying the previous one's half-finished confirmation
 * across. That is React's own answer to "reset state when a prop changes", and
 * it beats an effect that writes state during render.
 */
export function PlanInspector({
  unit, now, canPlan, showAudio, projectId, getToken, lane, languageLabel, laneCount,
  assignments, audioFiles, onPatch, onClose, onStep, onGoToFirstOpen, onOpenCell, onOpenUnit,
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
  onGoToFirstOpen?: (kind: PlanOpenKind) => void
  /**
   * AQU-1278: open the editor at ONE cell, from a verse chip in the chapter
   * card. Same division of labour as `onGoToFirstOpen` — this panel knows which
   * cell was clicked and nothing about where the editor lives. Absent, the
   * chips still draw (they say which verses are short, which is worth
   * something on its own) and simply do nothing when pressed.
   */
  onOpenCell?: (cellId: string) => void
  /**
   * AQU-1278 (Sam, 2026-09-17): open the editor on this unit's FILE, from its
   * title. The plain "take me there" beside the two targeted links above — a
   * reader who wants the file itself, not the first gap in it, used to have
   * to close the panel and find the file in the sidebar. Same division of
   * labour as the others: where the editor lives is ProjectOverview's
   * business. Absent, the title is plain text.
   */
  onOpenUnit?: () => void
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
  const readoutTips = usePlanReadoutTips()
  const { sections } = usePlanUnitSections({ projectId, unit, getToken, lane })

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
  const hasAudio = audioFiles ? audioFiles.has(unit.fileId) : planUnitExpectsAudio(unit)
  const shortfall = planUnitShortfall(unit, hasAudio)
  // AQU-1278: the cue sheet's cell count on a dubbing project, the unit's own
  // everywhere else. See `planAudioTotal`. The bars here are the only place it
  // is needed — the "Assigned to" block is handed its own audio gate by
  // `ProjectOverview`, which turns it off on a unit that records against a
  // sheet, and a file with a sheet has no chapter grid to feed.
  const audioTotal = planAudioTotal(unit)
  // Not `status === "nearly_complete"`: a unit that is ALSO overdue is filed
  // under Overdue, and it is precisely the row that needs its shortfall said
  // out loud. `planUnitIsNearlyComplete` asks the same question with the date
  // stripped, so the row and this panel cannot drift apart.
  const nearlyComplete = planUnitIsNearlyComplete(unit, now, audioFiles)
  // The same words the row uses, from the same renderer: "3 cells to validate",
  // or "6 to translate · 8 to validate" when two mediums are outstanding. Null
  // means nothing is, which on a unit nobody has marked done is its own news.
  const shortfallText = usePlanShortfallText(shortfall)

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
  /**
   * The open chapter's verses, fetched when a chapter is open and not before.
   *
   * ON THE OPEN KEY, never on the grid. `cells.canonical_ref` is unindexed, so
   * each of these is a full-file scan; a grid that prefetched its fifty tiles
   * would be fifty of them. This fires only for the one chapter a reader
   * deliberately opened, and `load` is idempotent, so a re-render costs
   * nothing.
   *
   * `load`'s identity carries the project, file and LANE, so this is also what
   * refreshes an open chapter when the reader changes target language from the
   * board's picker: the cache key changed, the chips would otherwise sit empty
   * until the chapter was closed and reopened.
   */
  const loadVerses = sectionVerses.load
  useEffect(() => {
    if (openSectionKey) loadVerses(openSectionKey)
  }, [openSectionKey, loadVerses])
  const openSectionTitle = (() => {
    if (!openSection) return ""
    const numbered = numberedBookCodes(sections.map((s) => s.key))
    const kind = classifyPlanSection(openSection.key, numbered)
    // A numbered chapter — and a one-chapter book, which IS chapter 1 — names
    // itself that way. Front matter gets the words the grid's own tile uses
    // for it rather than its bare book code, which a reader has no reason to
    // recognise as "the bit before chapter 1". A document's own sections keep
    // the names they have; "Chapter Scene 4" would invent one that does not
    // exist.
    return kind.kind === "chapter"
      ? t("org.projectOverview.plan.chapterTitle", { chapter: kind.n })
      : kind.kind === "frontMatter"
        ? t("org.projectOverview.plan.frontMatter")
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

  // NO SECTIONS, NO BLOCK — AQU-1278, Sam's call 2026-09-16. This used to
  // render the heading and a sentence explaining the absence: one for a media
  // file whose sections are time buckets, another for a Word document that has
  // none at all. A panel that spends a heading and a line of prose on something
  // it is not going to show is worse than a panel that simply moves on, and
  // the explanation had to be right about the file's kind to not be a lie.
  // With it goes the loading-vs-empty dance the sentence needed: nothing is
  // drawn until there is something to draw.
  const showBreakdown = sections.length > 0

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

  // ONE LINK, NEVER TWO, and it goes where the words point: the queue the
  // shortfall names first, by the one rule in `planOpenKind`. Text before
  // audio, and within text translation before validation, because a cell
  // nobody has written cannot be validated. So a unit whose text is finished
  // and whose takes are not sends its reader to the first cell with no take
  // (Sam, 2026-09-16), where it used to offer nothing at all. Null only when
  // nothing is outstanding, which is "Nothing left" and has no cell to land on.
  const openKind = planOpenKind(shortfall)

  return (
    <aside
      data-testid="plan-inspector"
      aria-label={t("org.projectOverview.plan.inspectorAria", { unit: planUnitLabel(unit) })}
      className="flex h-full min-h-0 flex-col overflow-hidden border-s bg-card"
    >
      <header className="flex items-start justify-between gap-2.5 border-b px-4 py-3.5">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold tracking-tight">
            {onOpenUnit ? (
              // Styled as the board's other links are: the words as they were,
              // a dotted underline on hover and focus, so the title still reads
              // as a title until the pointer asks it what it does.
              <AppTooltip content={t("org.projectOverview.plan.openFile")}>
                <button
                  type="button"
                  data-testid="plan-inspector-open-file"
                  onClick={onOpenUnit}
                  className="block max-w-full truncate rounded-sm text-start decoration-dotted underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {planUnitLabel(unit)}
                </button>
              </AppTooltip>
            ) : planUnitLabel(unit)}
          </h3>
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
              tips={readoutTips("text", unit.filledCount, unit.validatedCount, unit.totalCount)}
            />
            {showAudio && (
              <PlanBar
                label={t("org.projectOverview.plan.audioBarLabel")}
                outer={planPct(unit.audioCount, audioTotal)}
                inner={planPct(unit.audioValidatedCount, audioTotal)}
                tone="audio"
                aria={t("org.projectOverview.plan.audioBarsAria", {
                  recorded: planPct(unit.audioCount, audioTotal),
                  validated: planPct(unit.audioValidatedCount, audioTotal),
                })}
                tips={readoutTips("audio", unit.audioCount, unit.audioValidatedCount, audioTotal)}
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
            {/* WHAT IS LEFT, AND THE WAY TO IT — under the bars, for every kind
                of unit. AQU-1278 first put this on the chapter grid's summary
                line, which is where the mockup drew it and where it reads best
                on a book; Sam found the hole that placement leaves (2026-09-16).
                A subtitle file and a Word document have no grid at all, so the
                one link that takes a manager to the remaining work existed for
                books and for nothing else — on exactly the units whose whole
                panel is these two bars.
                Beneath the bars it belongs to the unit rather than to its
                chapters, which is what it always measured. The grid keeps the
                per-chapter count. */}
            {nearlyComplete && (
              <div
                // FLUSH LEFT, where the bars' LABELS start and not where their
                // tracks do. The `ps-8` above belongs to the audio note, which
                // explains the bar it sits under; this line is about the unit,
                // so it lines up with the section rather than hanging off a
                // bar (Sam, 2026-09-16).
                className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1 text-[11.5px]"
                data-testid="plan-unit-shortfall"
              >
                <span className={shortfallText ? `font-medium ${PLAN_TONE.nearly_complete.text}` : "text-muted-foreground"}>
                  {shortfallText ?? t("org.projectOverview.plan.nothingLeft")}
                </span>
                {/* NEARLY COMPLETE ONLY, and so are the grid's count badges. A
                    unit with ninety chapters to go gets no link, on the grounds
                    that "first outstanding cell" is not a useful place to stand
                    when nearly everything is outstanding; you open the file, not
                    a cell. THIS IS FLAGGED FOR RE-CONFIRMATION AT BUILD REVIEW:
                    it is the one rule in AQU-1278 that withholds something from
                    the majority of units, and if the answer changes it changes
                    on the condition above and in the `nearlyComplete` prop
                    passed to the grid, nowhere else. */}
                {openKind != null && onGoToFirstOpen && (
                  <Button
                    variant="link"
                    size="sm"
                    // The link variant paints itself `text-primary`, which is a
                    // lighter blue than the shortfall sharing this line — two
                    // blues an inch apart, reading as two different kinds of
                    // thing when they are one sentence. Both take the plan's
                    // own nearly-complete rung instead.
                    className={`h-auto gap-1 p-0 text-[12px] ${PLAN_TONE.nearly_complete.text}`}
                    data-testid="plan-go-to-first-open"
                    onClick={() => onGoToFirstOpen(openKind)}
                  >
                    {t(GO_TO_FIRST_KEY[openKind] as never)}
                    <ArrowRight className="h-3 w-3" aria-hidden />
                  </Button>
                )}
              </div>
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
              selectedKey={openSectionKey}
              // Pure state. The fetch used to be launched from inside this
              // updater, which made a request a side effect of rendering:
              // React may call an updater more than once, and StrictMode
              // deliberately calls it twice, so one click fired two or three
              // identical full-file scans. Opening a chapter is now a state
              // change, and the effect above turns that state into the one
              // request it needs.
              onSelect={(key) => setOpenSectionKey((open) => (open === key ? null : key))}
            />

            {/* ONE of the two, never both. "3 chapters short" and "47 of 50
                complete" are the same fact counted from opposite ends, and a
                line carrying both made a reader do the subtraction to check
                they agreed. What is left wins while anything is left; the
                complete line takes over when nothing is, where it is the more
                direct way to say the book is finished.
                The link used to share this line. It moved up under the bars,
                where every unit can have one — see `plan-unit-shortfall`. */}
            <div className="text-[11.5px]" data-testid="plan-grid-summary">
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
            </div>

            {/* One chapter, opened from the grid: the same nested bars the unit
                itself draws, so the part is measured exactly like the whole. */}
            {openSection && (
              // KEYED BY CHAPTER, so opening another one gets a fresh card.
              // Without this React reuses the instance, and the chip strip —
              // which is a scroll container — keeps the scroll offset of the
              // chapter before it: open a chapter with forty short verses,
              // scroll to the end, open one with three, and the new chips are
              // scrolled out of sight in an apparently empty row.
              <PlanChapterCard
                key={openSection.key}
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
 * The bars read in percentages like every other bar on the board, with the
 * counts one hover away (Sam, 2026-09-17). The card's header still says
 * "2 cells not yet validated" in print.
 *
 * THE TITLE OPENS THE CHAPTER (Sam, 2026-09-17): "Chapter 17" is a link to the
 * chapter's first cell, the way the panel's own title opens the book. The
 * verses the chips are drawn from arrive in canonical order, so the first of
 * them IS the chapter's first cell and no second request is needed; until
 * they arrive, or if they never do, the title is plain text.
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
  const readoutTips = usePlanReadoutTips()
  const rowRef = useRef<HTMLDivElement>(null)

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
            : lead.kind === "record"
              ? "org.projectOverview.plan.chapterTakesUnrecorded"
              // audio_validate: these takes ARE recorded — what they lack is
              // validation, and the old fall-through said "not yet recorded",
              // sending the reader to record work that already existed. The
              // branch is DORMANT today: AUDIO_JUDGED_ON_RECORDED zeroes the
              // audio_validate part everywhere, so no test can reach it
              // through the panel until AQU-490 flips that flag. It is here
              // so flip day changes the measurement, not the words.
              : "org.projectOverview.plan.chapterTakesUnvalidated") as never,
        { count: lead.count },
      )
    : null

  // The chips list the chapter's own lead queue — the same rule as the link,
  // so a chapter that reads "5 takes to record" lists the five verses with no
  // take. A worker from before verses carried take state sends no flags, and
  // an audio lead then draws no chips rather than every verse.
  const chipLead = planOpenKind(shortfall)
  const short = verses?.status === "ready" && chipLead
    ? shortVerses(verses.verses, chipLead)
    : []
  const fade = useScrollFade(rowRef, short.length)
  const firstCellId = verses?.status === "ready" ? verses.verses[0]?.cellId ?? null : null

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border bg-muted/40 px-2.5 py-2"
      data-testid="plan-chapter-detail"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 text-[12.5px] font-semibold" data-testid="plan-chapter-detail-title">
          {firstCellId && onOpenCell ? (
            <AppTooltip content={t("org.projectOverview.plan.openFile")}>
              <button
                type="button"
                data-testid="plan-chapter-open"
                onClick={() => onOpenCell(firstCellId)}
                className="block max-w-full truncate rounded-sm text-start decoration-dotted underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {title}
              </button>
            </AppTooltip>
          ) : title}
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
        // Percentages like every other bar, the counts one hover away (Sam,
        // 2026-09-17, for consistency). "20 of 20 translated · 18 of 20
        // validated" is what the hover says; the card's own header still
        // says "2 cells not yet validated" in print.
        tips={readoutTips("text", section.filledCount, section.validatedCount, section.totalCount)}
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
          tips={readoutTips("audio", section.audioCount, section.audioValidatedCount, section.totalCount)}
        />
      )}
      {/* ONE ROW, NEVER TWO — and it SCROLLS. Sam, 2026-09-16: every verse
          reachable, the card's height never depending on how badly a chapter
          is doing, and no "+N" chip, because the header above already says
          how many are left and a count that cannot be clicked was the least
          useful thing the row could end on. Fixed-width chips, so the strip
          reads as a set rather than a sentence.
          The scrollbar is hidden (the app's global rule would otherwise pin a
          12px track under the chips); the cut-off chip at the edge plus the
          fade are the affordance. `overscroll-x-contain` keeps a trackpad
          swipe past the last chip from turning into the browser's back
          gesture. */}
      {short.length > 0 && (
        <div
          ref={rowRef}
          className="flex gap-1 overflow-x-auto overscroll-x-contain whitespace-nowrap py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ maskImage: fadeMask(fade), WebkitMaskImage: fadeMask(fade) }}
          data-testid="plan-chapter-verses"
        >
          {short.map((v) => (
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
        </div>
      )}
    </div>
  )
}

/** Which edges of the chip strip have chips beyond them, in LOGICAL terms. */
interface ScrollFade {
  start: boolean
  end: boolean
  /** Whether the strip lays out right-to-left, which decides which physical edge each fade goes on. */
  rtl: boolean
}

/**
 * Which edges of the chip strip have more chips beyond them.
 *
 * The strip scrolls sideways, and macOS hides a scrollbar until it moves — so
 * the only sign that chips continue is the one cut off at the edge, and the
 * fade is what turns that from "broken" into "more". Answers are logical
 * (`start`/`end`) because `scrollLeft` runs NEGATIVE in a right-to-left strip,
 * and a fade painted on the wrong physical side would point away from the
 * content it exists to point at; `Math.abs` is what makes one measurement
 * serve both directions.
 *
 * Re-measured on scroll, on resize, and WHENEVER THE CHIP COUNT CHANGES. That
 * last dependency is the lesson of the rule this replaces: the row mounts
 * after the verses load, so an effect keyed on the ref alone measured nothing,
 * kept its "unbounded" default, and drew seven chips in a six-chip row.
 */
function useScrollFade(ref: RefObject<HTMLElement | null>, chipCount: number): ScrollFade {
  const [fade, setFade] = useState<ScrollFade>({ start: false, end: false, rtl: false })
  useLayoutEffect(() => {
    const row = ref.current
    if (!row) return
    const measure = () => {
      const scrolled = Math.abs(row.scrollLeft)
      const next: ScrollFade = {
        start: scrolled > 1,
        end: scrolled + row.clientWidth < row.scrollWidth - 1,
        rtl: getComputedStyle(row).direction === "rtl",
      }
      setFade((prev) =>
        prev.start === next.start && prev.end === next.end && prev.rtl === next.rtl ? prev : next,
      )
    }
    measure()
    row.addEventListener("scroll", measure, { passive: true })
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure) // happy-dom
    observer?.observe(row)
    return () => {
      row.removeEventListener("scroll", measure)
      observer?.disconnect()
    }
  }, [ref, chipCount])
  return fade
}

/** How far the fade reaches in from an edge: a little over half a chip. */
const FADE_PX = "28px"

/**
 * The mask that fades whichever edges have more behind them, or nothing when
 * every chip is in view. A mask rather than an overlay because the card sits
 * on a translucent wash over the panel, and an overlay would have to know the
 * exact composite colour to fade into; a mask fades to whatever is there.
 */
function fadeMask(f: ScrollFade): string | undefined {
  const left = f.rtl ? f.end : f.start
  const right = f.rtl ? f.start : f.end
  if (!left && !right) return undefined
  return `linear-gradient(to right, ${
    left ? `transparent, black ${FADE_PX}` : "black"
  }, ${
    right ? `black calc(100% - ${FADE_PX}), transparent` : "black"
  })`
}
