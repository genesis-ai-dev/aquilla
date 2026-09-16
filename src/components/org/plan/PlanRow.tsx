// AQU-1092…1098: one planning unit in the board.
//
// Three columns, because a row answers three questions in a fixed order: what
// is this, how is it going, and when is it due. The bars take the widest track
// and stretch — they are the only part that carries a shape rather than a word,
// so they get the room to be read at a glance across sixty-six rows.
//
// Status is NOT repeated per row. The group header above already says it, and a
// column of thirty-one identical "In progress" chips is noise. What the row
// carries instead is the thing that varies and the group cannot say: the date,
// and the one line that says how late, how soon, or how recently touched.
//
// AQU-1278 gave the third column a second question to answer — what is LEFT —
// because that is the one a manager actually opens this board with once the
// dates are set. It only ever appears on a unit that is nearly finished, where
// the answer is short enough to be a fact rather than a report, and it never
// pushes the date off the row: the date keeps line one whenever there is one.

import { useLayoutEffect, useRef, useState, type RefObject } from "react"
import { useT, useI18n } from "@/lib/i18n/I18nProvider"
import { fmtDeadlineDate } from "@/lib/format-date"
import { formatList } from "@/lib/i18n/format"
import {
  planPct,
  planUnitIsNearlyComplete,
  planUnitLabel,
  planUnitShortfall,
  planUnitStatus,
  type PlanUnit,
} from "@/lib/plan/plan-status"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { AppTooltip } from "@/components/ui/tooltip"
import { PlanBar } from "./PlanBar"
import { PlanStatusPill } from "./PlanStatusPill"
import { usePlanRowNote, usePlanShortfallText } from "./use-plan-note"

/** Whoever is on the hook for some slice of this unit. */
export interface PlanRowAssignee {
  userId: number
  username: string | null
}

/**
 * At most three faces, then a count. Three is where the group still reads as
 * individuals rather than as a texture, and it is what fits beside a book name
 * in the narrowest column on the board.
 */
const MAX_ASSIGNEE_CHIPS = 3

// Geometry of the chip strip, in pixels, written as numbers because the
// measurement below is arithmetic and not a class name. `InitialsAvatar`
// size="xs" is `size-5` (20px); `AvatarGroup`'s `-space-x-1.5` overlaps each
// chip 6px onto the one before it, so every chip after the first costs 14; and
// `gap-2` (8px) separates the strip from whatever precedes it. Change a class
// below and change these with it — nothing connects the two, and the symptom of
// a mismatch is a name that truncates by a few pixels on some rows only.
const CHIP_PX = 20
const CHIP_STEP_PX = 14
const CHIP_GAP_PX = 8

/** How many chips fit in `available` pixels, given they overlap. */
function chipsThatFit(available: number): number {
  if (available < CHIP_GAP_PX + CHIP_PX) return 0
  return 1 + Math.floor((available - CHIP_GAP_PX - CHIP_PX) / CHIP_STEP_PX)
}

/**
 * Split a set of assignees into the faces this row can show and the number it
 * has to fold into a "+N" chip.
 *
 * THE COUNT CHIP IS RESERVED FIRST AND DROPPED LAST, which is the whole rule in
 * one line. A squeezed row is allowed to show fewer NAMES than it has — that is
 * a detail the inspector carries anyway — but it must never show fewer PEOPLE,
 * because a manager who counts two faces and assigns a third body to the work
 * has been misled by the board rather than informed by it. So when only one
 * slot survives, that slot holds "+4" and not one arbitrary face.
 *
 * Kept module-private on purpose: exporting it costs this file its fast-refresh
 * guarantee (a module that exports anything but components reloads whole, and
 * the board loses its selection on every save), and the rule is observable from
 * the outside — narrow the column and count the chips.
 */
function assigneeChipSplit(
  total: number,
  capacity: number,
): { shown: number; overflow: number } {
  if (total <= 0) return { shown: 0, overflow: 0 }
  const wanted = Math.min(MAX_ASSIGNEE_CHIPS, total)
  if (total === wanted && capacity >= wanted) return { shown: wanted, overflow: 0 }
  // Everything below here needs a count chip, so one slot is spoken for.
  const shown = Math.max(0, Math.min(wanted, capacity - 1))
  return { shown, overflow: total - shown }
}

/**
 * How many chip slots the name column can spare, measured.
 *
 * THE NAME NEVER LOSES SPACE TO A CHIP. It is the narrowest of the three
 * columns and a half-truncated book name is the one thing on this board that
 * must not happen, so the chips are fitted into what the name leaves rather
 * than the other way round — hence a measurement instead of a flexbox rule.
 *
 * `scrollWidth` on the name is what makes this stable. It reports the name's
 * CONTENT width in both states: unsqueezed the element is already content-sized
 * (a flex item that does not grow), and squeezed the `truncate` overflow keeps
 * the full text measurable underneath. Read the name's laid-out width instead
 * and the measurement feeds back into itself — chips shrink the name, the
 * smaller name frees room, more chips appear — and the row oscillates.
 *
 * Re-measured on RESIZE and nothing else. The resize that matters is the
 * inspector docking and undocking beside the board, which takes a third of the
 * width away from every row at once; scroll changes nothing here, and a
 * listener per row on a sixty-six-row board would cost far more than it buys.
 */
function useAssigneeChipCapacity(
  cellRef: RefObject<HTMLElement | null>,
  nameRef: RefObject<HTMLElement | null>,
  reservedRef: RefObject<HTMLElement | null>,
  label: string,
  enabled: boolean,
): number {
  // Until something has been measured, assume there is room. The alternative —
  // start at zero and grow — makes every row flash a bare "+N" before settling,
  // and in a test environment with no ResizeObserver (happy-dom) it would mean
  // the chips never render at all and could never be asserted on.
  const [capacity, setCapacity] = useState(Number.POSITIVE_INFINITY)

  useLayoutEffect(() => {
    const cell = cellRef.current
    const name = nameRef.current
    if (!enabled || !cell || !name) return

    const measure = () => {
      const reserved = reservedRef.current?.offsetWidth ?? 0
      setCapacity(chipsThatFit(cell.clientWidth - name.scrollWidth - reserved))
    }

    measure()
    if (typeof ResizeObserver === "undefined") return // happy-dom

    const observer = new ResizeObserver(measure)
    observer.observe(cell)
    return () => observer.disconnect()
    // `label` is in the deps because a longer name eats the same room a narrower
    // column would, and no resize fires when only the text changes.
  }, [cellRef, nameRef, reservedRef, label, enabled])

  return capacity
}

/**
 * How many short chapters a row names before it starts counting the rest. The
 * third column is the narrowest of the three and the name beside it must never
 * truncate, so the list is what gives way.
 */
const WHERE_CHAPTERS_NAMED = 3

export function PlanRow({
  unit,
  now,
  selected,
  showAudio,
  showStatus = false,
  onSelect,
  audioFiles,
  shortChapters,
  onOpenShortfall,
  assignees,
}: {
  unit: PlanUnit
  now: number
  selected: boolean
  showAudio: boolean
  /**
   * Order mode only. With no group header above it the row has to say its own
   * status, and it says it beside the name rather than in a fourth column, so
   * the grid is identical in both arrangements.
   */
  showStatus?: boolean
  onSelect: () => void
  /**
   * Files that carry recordings, from `audioFileIds` over the WHOLE board.
   * Optional so the row stays testable alone; omitted, the unit's own audio
   * count stands in, which is right for one row and wrong for a board.
   */
  audioFiles?: ReadonlySet<string>
  /** Labels of the chapters still short, already ordered — e.g. ["12", "40"]. */
  shortChapters?: string[]
  /** Opens the editor at the first outstanding cell. Absent → plain text. */
  onOpenShortfall?: () => void
  assignees?: readonly PlanRowAssignee[]
}) {
  const t = useT()
  const { locale } = useI18n()
  const status = planUnitStatus(unit, now, audioFiles)
  const translated = planPct(unit.filledCount, unit.totalCount)
  const validated = planPct(unit.validatedCount, unit.totalCount)
  const recorded = planPct(unit.audioCount, unit.totalCount)
  const audioValidated = planPct(unit.audioValidatedCount, unit.totalCount)
  const note = usePlanRowNote(unit, now, audioFiles)

  const hasAudio = audioFiles ? audioFiles.has(unit.fileId) : unit.audioCount > 0
  const shortfall = planUnitShortfall(unit, hasAudio)
  const nearly = planUnitIsNearlyComplete(unit, now, audioFiles)
  const shortfallText = usePlanShortfallText(shortfall)
  // Null from the renderer means nothing is outstanding, which on a unit nobody
  // has marked done is itself the news — see `nothingLeft` in the catalog.
  const leftToDo = nearly ? (shortfallText ?? t("org.projectOverview.plan.nothingLeft")) : null

  const label = planUnitLabel(unit)
  const nameCellRef = useRef<HTMLSpanElement>(null)
  const nameRef = useRef<HTMLSpanElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const capacity = useAssigneeChipCapacity(
    nameCellRef,
    nameRef,
    pillRef,
    label,
    (assignees?.length ?? 0) > 0,
  )
  const { shown, overflow } = assigneeChipSplit(assignees?.length ?? 0, capacity)

  // LINE 1 is the date whenever there is one, unchanged and red when it has been
  // blown. Only a unit with no date at all gives the line up, and then only to
  // say what is left — which is the same trade the column has always made:
  // whatever varies most between rows wins the line.
  const line1LeftToDo = !unit.targetDate && leftToDo !== null
  const openable = line1LeftToDo && shortfallText !== null && onOpenShortfall !== undefined

  // LINE 2 carries whatever line 1 could not. A dated nearly-complete unit puts
  // the shortfall here, ahead of the note, joined by the catalog's own pair
  // separator; an undated one has already spent line 1 on the shortfall, so this
  // line points at WHERE the remaining cells are instead of repeating it.
  const chapterList = shortChapters ?? []
  let line2: string | null = note
  if (unit.targetDate && leftToDo !== null) {
    line2 = note
      ? t("org.projectOverview.plan.shortfallPair", { first: leftToDo, second: note })
      : leftToDo
  } else if (line1LeftToDo && shortfallText === null) {
    // AQU-1278. Line 1 already says "Nothing left"; the question a reader has
    // in front of a finished book is why it is not in Done. "no target date",
    // which this used to inherit, answers a question nobody asked.
    line2 = t("org.projectOverview.plan.nothingLeftUndone")
  } else if (line1LeftToDo && shortfallText !== null && chapterList.length > 0) {
    // Named up to three, then counted. A nearly-complete Psalms can be short in
    // forty chapters, and forty numbers joined into one line is not a sentence
    // a reader finishes — it pushes the row's own height around and says less
    // than "chapters 4, 22, 78 and 37 more" does. Three is what fits beside the
    // widest book name at the narrowest width this column is allowed to reach.
    //
    // `formatList` rather than join(", "): the separator and the final
    // conjunction are locale business, and Intl already owns them.
    const named = chapterList.slice(0, WHERE_CHAPTERS_NAMED)
    const rest = chapterList.length - named.length
    // CONJUNCTION when the list is complete — "12 and 40" — and the plain unit
    // join when it is not, because `shortfallWhereMore` supplies its own "and"
    // for the remainder and two of them read as "4, 9, and 17 and 4 more".
    const list = formatList(named, locale, rest > 0 ? undefined : { type: "conjunction" })
    line2 = rest > 0
      ? t("org.projectOverview.plan.shortfallWhereMore", { count: rest, list })
      : t("org.projectOverview.plan.shortfallWhere", { count: chapterList.length, list })
  }

  // AQU-1278: and when the line is still just the note, say whether anybody is
  // on this unit at all.
  //
  // ONLY FOR A UNIT WHOSE ASSIGNMENTS ARE KNOWN. `undefined` means nobody has
  // asked yet — there is no project-wide assignee read, so the board learns a
  // unit's assignments when a manager opens it — and an empty array means the
  // question was asked and the answer was nobody. Printing "unassigned" for
  // the first would tell a manager to staff a book that already has two people
  // on it, which is worse than saying nothing.
  if (assignees !== undefined && assignees.length === 0 && leftToDo === null) {
    const unassigned = t("org.projectOverview.plan.unassignedRow")
    line2 = line2
      ? t("org.projectOverview.plan.shortfallPair", { first: unassigned, second: line2 })
      : unassigned
  }

  // Where the click lands, said in words for a screen reader. Only the two text
  // media can be named: the catalog has no wording for "first unrecorded", and
  // borrowing one of these for a recording queue would tell a reader the link
  // goes somewhere it does not. A record-led shortfall therefore keeps the
  // visible count as its own accessible name, which is true if terse.
  //
  // An aria-label REPLACES the text it labels, so the destination is joined to
  // the count rather than sent in its place — "4 cells to validate · Go to
  // first unvalidated". The join borrows `shortfallPair`, which exists to put
  // two already-rendered fragments together under a separator a translator
  // chooses; a hand-written one here would be untranslated copy in a .tsx.
  const openDestination =
    shortfall.toTranslate > 0
      ? t("org.projectOverview.plan.goToFirstUntranslated")
      : shortfall.toValidate > 0
        ? t("org.projectOverview.plan.goToFirstUnvalidated")
        : null
  const openLabel =
    openDestination && leftToDo
      ? t("org.projectOverview.plan.shortfallPair", { first: leftToDo, second: openDestination })
      : null

  return (
    <li>
      <button
        type="button"
        data-testid={`plan-row-${unit.fileId}-${unit.sectionKey}`}
        // The board focuses rows by unit id when the arrows move the
        // selection; the testid's shape cannot be matched to one reliably.
        data-plan-unit={`${unit.fileId}:${unit.sectionKey}`}
        data-selected={selected ? "true" : undefined}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        // AQU-1278 widened the third column from minmax(130px,0.7fr) and took
        // every pixel of it off the bars, which had the slack: the minimums
        // still add to 520 and the fractions still add to 3.5, so nothing else
        // on the board reflows. The bars lose width they were only stretching
        // into; the date column gained a second line with words in it.
        className={`grid w-full grid-cols-1 items-center gap-2 px-[17px] py-3 text-start transition-colors hover:bg-muted/60 md:grid-cols-[minmax(150px,1fr)_minmax(200px,1.6fr)_minmax(170px,0.9fr)] md:gap-4 ${
          selected ? "bg-muted shadow-[inset_3px_0_0_var(--color-primary)]" : ""
        }`}
      >
        <span ref={nameCellRef} className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span ref={nameRef} className="truncate text-[13.5px] font-semibold text-foreground">
              {label}
            </span>
            {/*
              The pill is measured, so it is wrapped in something with a width of
              its own and pinned with `shrink-0`: a pill that squeezed when the
              chips arrived would change the very number that decides how many
              chips arrive. It also stays welded to the name — the chips take the
              end of the strip, where dropping one leaves no hole behind it.
            */}
            {showStatus && (
              <span ref={pillRef} className="shrink-0">
                <PlanStatusPill status={status} now={now} compact />
              </span>
            )}
            {assignees && assignees.length > 0 && (
              <AvatarGroup
                className="shrink-0 -space-x-1.5 *:data-[slot=avatar]:ring-background"
                aria-label={t("org.projectOverview.plan.assignedTo")}
              >
                {assignees.slice(0, shown).map((a) => {
                  // A username is nullable on the wire. The numeric id is a poor
                  // label but an honest one, and it still colours and initials
                  // deterministically, so the same person keeps the same chip.
                  const name = a.username ?? `#${a.userId}`
                  return (
                    <AppTooltip key={a.userId} content={name}>
                      <InitialsAvatar name={name} size="xs" />
                    </AppTooltip>
                  )
                })}
                {overflow > 0 && (
                  <AvatarGroupCount
                    className="size-5 text-[9px] font-semibold"
                    aria-label={t("org.projectOverview.plan.moreAssignees", { count: overflow })}
                  >
                    +{overflow}
                  </AvatarGroupCount>
                )}
              </AvatarGroup>
            )}
          </span>
          <span className="text-[11.5px] tabular-nums text-muted-foreground">
            {t("org.projectOverview.plan.cellCount", { count: unit.totalCount })}
          </span>
        </span>

        <span className="flex flex-col gap-1.5">
          <PlanBar
            label={t("org.projectOverview.plan.textBarLabel")}
            outer={translated}
            inner={validated}
            tone="text"
            aria={t("org.projectOverview.plan.textBarsAria", { translated, validated })}
          />
          {showAudio && (
            <PlanBar
              label={t("org.projectOverview.plan.audioBarLabel")}
              outer={recorded}
              inner={audioValidated}
              tone="audio"
              aria={t("org.projectOverview.plan.audioBarsAria", {
                recorded,
                validated: audioValidated,
              })}
            />
          )}
        </span>

        {/* The reason the board exists: when is it due, what is left, and how is it going. */}
        <span className="flex flex-col gap-0.5 md:text-end">
          <span
            data-testid={`plan-date-${unit.fileId}-${unit.sectionKey}`}
            className={`text-[12.5px] whitespace-nowrap tabular-nums ${
              status === "overdue"
                ? "font-semibold text-destructive"
                : unit.targetDate || line1LeftToDo
                  ? "text-foreground"
                  : "text-muted-foreground"
            }`}
          >
            {unit.targetDate ? (
              fmtDeadlineDate(unit.targetDate, now, locale)
            ) : openable ? (
              /*
                NOT A <button>. This row is itself a button, and a button inside
                a button is invalid HTML that React warns about and that some
                browsers un-nest while parsing — the inner control then loses its
                click entirely. A span carrying the button ROLE keeps the pointer
                and keyboard behaviour without the nesting, and the propagation
                stop is what keeps a click here from also selecting the row: this
                link means "take me to the work", not "tell me more about it".
              */
              <span
                role="button"
                tabIndex={0}
                data-testid={`plan-shortfall-${unit.fileId}-${unit.sectionKey}`}
                aria-label={openLabel ?? undefined}
                className="cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenShortfall?.()
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return
                  // Space scrolls the board and Enter would activate the row
                  // underneath; both have to be swallowed, not just handled.
                  e.preventDefault()
                  e.stopPropagation()
                  onOpenShortfall?.()
                }}
              >
                {leftToDo}
              </span>
            ) : (
              (leftToDo ?? t("org.projectOverview.plan.noTargetShort"))
            )}
          </span>
          {/* AQU-1278: neither line may wrap. The third column is the
              narrowest on the board, and a shortfall that broke over two lines
              took the whole row's height with it — sixty-six rows of which is
              a different page. Line 1 is short enough to hold; line 2 gives way
              with an ellipsis rather than reflowing. */}
          <span className="truncate text-[11.5px] text-muted-foreground">
            {line2 ?? "—"}
          </span>
        </span>
      </button>
    </li>
  )
}
