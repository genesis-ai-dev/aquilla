// AQU-1278: the inspector's "Assigned to" section — who owns a slice of this
// planning unit, and how far each of them has actually got inside it.
//
// The unit's own two bars sit a few inches above this section, so every person
// here draws THE SAME PlanBar those bars use. Two components drawing "a
// progress bar" side by side is how one of them quietly ends up a pixel taller,
// a shade off, or rounding differently from the other, and a reader comparing
// "Anna's share" against "the book" would be comparing two drawings rather than
// two numbers.
//
// What differs is the READOUT: a unit reads in percentages, a person reads in
// CELLS. At this grain "940/938" is a fact a manager can act on — twelve cells
// left — where "99/99%" is those twelve cells rounded into invisibility. The
// counts therefore sit BESIDE each bar rather than inside it, because PlanBar's
// own readout is hard-coded to "outer/inner%" and PlanBar belongs to the board;
// `AssignmentBar` at the foot of this file is the one place that changes on the
// day it takes a readout node instead.
//
// EVERY LANE IS LISTED, and that is a product decision, not an oversight. An
// assignment is pinned to one target-language lane (AQU-538 §3.5), but the
// project-overview Assign panel never pins one, so almost every assignment that
// exists today sits on the default lane. Filtering this list to the lane the
// inspector happens to be showing would therefore render an EMPTY "Assigned to"
// on every non-default tab of every real project — a unit that is fully spoken
// for, reading as unassigned. Sam's call (2026-09-15) was "show all, chip the
// odd ones": an assignment whose lane differs from the one on screen gets a
// small language chip so nobody mistakes it for work in the language they are
// looking at.

import { useMemo, useState } from "react"
import { useT, useI18n } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { AssignModal } from "@/components/AssignModal"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { fmtDeadlineDate } from "@/lib/format-date"
import { planPct, planUnitShortfall, type PlanShortfall } from "@/lib/plan/plan-status"
import type { UnitAssignment } from "@/lib/sync/assignments"
import type { FileReference, FileType } from "@/lib/parsers/types"
import { SectionVisibilityGate } from "../SectionVisibilityBadge"
import { laneChipLabel } from "../project-lanes"
import { PlanBar } from "./PlanBar"
import { usePlanShortfallRenderer } from "./use-plan-note"

/** AssignModal takes the editor's cell selection; a PM surface has none. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set()

/**
 * What ONE PERSON still owes on this unit.
 *
 * Routed through `planUnitShortfall` on a synthetic unit — the same move
 * `planSectionShortfall` makes for a chapter tile, for the same reason. That
 * function owns two decisions a hand-written subtraction here would get wrong
 * within a release: every term is clamped at zero (a unit can report more audio
 * than cells — see its note), and `AUDIO_JUDGED_ON_RECORDED` decides whether
 * audio is judged on takes recorded or takes signed off. When AQU-490 lands and
 * that constant flips, this person's line flips with the bar above it instead
 * of contradicting it.
 *
 * `hasAudio` is the FILE's audio expectation, handed down rather than inferred
 * from this person's own `recorded` count: a translator assigned text in a
 * dubbed book has recorded nothing, and judging their share on their own zero
 * would quietly decide audio is expected of nobody.
 */
function assignmentShortfall(a: UnitAssignment, hasAudio: boolean): PlanShortfall {
  return planUnitShortfall(
    {
      fileId: "",
      fileName: "",
      sectionKey: "",
      totalCount: a.cellsTotal,
      filledCount: a.translated,
      validatedCount: a.validated,
      audioCount: a.recorded,
      audioValidatedCount: a.audioValidated,
      lastEditAt: null,
      targetDate: null,
      doneAt: null,
      doneBy: null,
    },
    hasAudio,
  )
}

/** Everything the Assign affordance needs. Omit it to render no button. */
export interface PlanAssignTarget {
  projectId: string
  /**
   * The unit's file. AssignModal opens pre-scoped to it ("all verses in this
   * file"), which is as close to this unit as the modal can currently be aimed.
   *
   * SWARM-TODO(AQU-1278): scoping it to the unit's BOOK needs a new AssignModal
   * prop (a `defaultBookKey` / `defaultChapters` that seeds the chapters scope
   * from a section key). AssignModal is owned by neither this feature nor this
   * file, so the file scope stands until that prop exists — a manager assigning
   * one book of a 66-book file has to check the chapters themselves.
   */
  activeFileId: string
  files: { id: string; name: string }[]
  /** Extra (non-default) lane tags, so the modal can offer its lane select. */
  targetLanes: string[]
  jwt: string
  author: string
  roleLevel: number
  allowSelfAssignment: boolean
  assignmentMinRole: number
  callerUserId: number | null
  /** Re-read the unit's assignments; this is an AD-3 read, nothing is pushed. */
  onAssigned: () => void
}

export interface PlanAssignmentsProps {
  /** Every live assignment covering the unit, in any lane. */
  assignments: readonly UnitAssignment[]
  /**
   * The page's single clock, captured once per render pass by the owner. Read
   * from `Date.now()` here instead and one person's deadline could format
   * against a different instant from the unit's own date two inches above it —
   * and a render would stop being a pure function of its props.
   */
  now: number
  /** The lane the inspector is showing; '' = the project's default lane. */
  lane: string
  /** Display name of the '' lane — the project's own target language. */
  defaultLaneLabel: string
  /** Does the unit's FILE carry recordings? Drives the audio bar, per file. */
  showAudio: boolean
  /**
   * How many of the unit's chapters nobody is assigned to. Omitted when the
   * caller cannot know — see ProjectOverview, where it currently always is:
   * the per-unit read aggregates each assignment's cells into counts and
   * returns no chapter attribution, so there is nothing honest to count yet.
   */
  unassignedChapters?: number
  /** The org's memberProgressViewMinRole. Same floor the Team card uses. */
  minRole: number
  viewerRoleLevel: number | null | undefined
  /** True once that floor is known; false renders nothing at all. */
  ready: boolean
  assign?: PlanAssignTarget
}

/**
 * GATED ON memberProgressViewMinRole (AQU-485), exactly as the Team card is —
 * this is one person's productivity broken out by name, which is precisely what
 * that org setting governs. NOT on `canPlan`: that is the MAINTAINER floor for
 * setting dates and marking units done, a different question with a different
 * answer, and reusing it here would both show this to maintainers whose org
 * hid per-member progress and hide it from the contributors an org deliberately
 * opened it to.
 */
export function PlanAssignments({
  assignments,
  now,
  lane,
  defaultLaneLabel,
  showAudio,
  unassignedChapters,
  minRole,
  viewerRoleLevel,
  ready,
  assign,
}: PlanAssignmentsProps) {
  const t = useT()
  const [assignOpen, setAssignOpen] = useState(false)

  // Nothing to say and no way to act: render no heading rather than an empty
  // box under a label, which reads as a section that failed to load.
  if (assignments.length === 0 && !assign && unassignedChapters == null) return null

  return (
    <SectionVisibilityGate minRole={minRole} viewerRoleLevel={viewerRoleLevel} ready={ready}>
      <div className="flex flex-col gap-2" data-testid="plan-assignments">
        <div className="flex items-center justify-between gap-2">
          <Label>{t("org.projectOverview.plan.assignedTo")}</Label>
          {assign && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="plan-assign-open"
              onClick={() => setAssignOpen(true)}
            >
              {t("org.projectOverview.plan.assign")}
            </Button>
          )}
        </div>

        {assignments.length > 0 && (
          <ul className="flex flex-col gap-2">
            {assignments.map((a) => (
              <PlanAssignmentRow
                key={a.assignmentId}
                assignment={a}
                now={now}
                lane={lane}
                defaultLaneLabel={defaultLaneLabel}
                showAudio={showAudio}
              />
            ))}
          </ul>
        )}

        {unassignedChapters != null && (
          <p className="text-[11.5px] text-muted-foreground" data-testid="plan-assignment-coverage">
            {unassignedChapters > 0
              ? t("org.projectOverview.plan.unassignedChapters", { count: unassignedChapters })
              : t("org.projectOverview.plan.everyChapterAssigned")}
          </p>
        )}

        {/* Mounted only while it is open, so the roster read is lazy — the same
            arrangement OrgLaneAssignModal makes for the org dashboard. */}
        {assignOpen && assign && (
          <PlanAssignHost
            target={assign}
            lane={lane}
            defaultLaneLabel={defaultLaneLabel}
            onClose={() => setAssignOpen(false)}
          />
        )}
      </div>
    </SectionVisibilityGate>
  )
}

/** One person's slice of the unit: who, what, and how far. */
function PlanAssignmentRow({
  assignment: a,
  now,
  lane,
  defaultLaneLabel,
  showAudio,
}: {
  assignment: UnitAssignment
  now: number
  lane: string
  defaultLaneLabel: string
  showAudio: boolean
}) {
  const t = useT()
  const { locale } = useI18n()
  const name = a.username ?? t("org.workloadRollup.unknownUser", { id: a.assigneeUserId })
  // '' and a real tag are different lanes, so compare the values themselves
  // rather than falsiness — the default lane IS a lane (AQU-728).
  const otherLane = a.targetLang !== lane
  // The unit's own shortfall line and this one are rendered by the SAME
  // function, so "12 cells to validate" on a person and on the book they are
  // working through can never be worded two ways. Null there means nothing is
  // outstanding, which this surface — unlike the row, which has a chapter grid
  // saying it in colour — has to put into words.
  const renderShortfall = usePlanShortfallRenderer()
  const left =
    renderShortfall(assignmentShortfall(a, showAudio)) ??
    t("org.projectOverview.plan.nothingLeft")

  const meta = [
    t("org.projectOverview.plan.assignmentScope", {
      scope: a.scopeLabel,
      count: a.cellsTotal,
    }),
    a.deadline
      ? t("org.projectOverview.plan.assignmentDue", {
          date: fmtDeadlineDate(a.deadline, now, locale),
        })
      : t("org.projectOverview.plan.assignmentNoDeadline"),
  ].join(" · ")

  return (
    <li
      className="flex flex-col gap-1 rounded-md border bg-muted/30 px-2.5 py-2"
      data-testid={`plan-assignment-${a.assignmentId}`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <UsernameWithAvatar username={name} size="xs" nameClassName="text-[13px]" />
        {/* The chip only appears on the rows that need explaining, so a
            single-lane project never grows a column of identical tags. */}
        {otherLane && (
          <span
            data-testid="plan-assignment-lane"
            className="shrink-0 rounded border bg-card px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground"
          >
            {laneChipLabel(a.targetLang, defaultLaneLabel, t("org.projectOverview.laneDefaultFallback"))}
          </span>
        )}
      </div>

      <p className="text-[11.5px] text-muted-foreground">{meta}</p>

      <div className="flex flex-col gap-[3px]">
        <AssignmentBar
          label={t("org.projectOverview.plan.textBarLabel")}
          outer={planPct(a.translated, a.cellsTotal)}
          inner={planPct(a.validated, a.cellsTotal)}
          tone="text"
          aria={t("org.projectOverview.plan.textBarsAria", {
            translated: planPct(a.translated, a.cellsTotal),
            validated: planPct(a.validated, a.cellsTotal),
          })}
          counts={`${a.translated}/${a.validated}`}
          testId={`plan-assignment-text-${a.assignmentId}`}
        />
        {showAudio && (
          <AssignmentBar
            label={t("org.projectOverview.plan.audioBarLabel")}
            outer={planPct(a.recorded, a.cellsTotal)}
            inner={planPct(a.audioValidated, a.cellsTotal)}
            tone="audio"
            aria={t("org.projectOverview.plan.audioBarsAria", {
              recorded: planPct(a.recorded, a.cellsTotal),
              validated: planPct(a.audioValidated, a.cellsTotal),
            })}
            counts={`${a.recorded}/${a.audioValidated}`}
            testId={`plan-assignment-audio-${a.assignmentId}`}
          />
        )}
      </div>

      <p
        className="text-end text-[11px] text-muted-foreground"
        data-testid={`plan-assignment-left-${a.assignmentId}`}
      >
        {left}
      </p>
    </li>
  )
}

/**
 * One bar of a person's progress: the unit's own PlanBar, with the cell counts
 * beside it.
 *
 * The counts sit OUTSIDE PlanBar because PlanBar's readout is hard-coded to
 * "outer/inner%" and PlanBar belongs to the board, not to this section. The day
 * it takes a `readout` node, this wrapper collapses into passing one — which is
 * exactly why the wrapper exists rather than a second bar implementation.
 */
function AssignmentBar({
  label,
  outer,
  inner,
  tone,
  aria,
  counts,
  testId,
}: {
  label: string
  outer: number
  inner: number
  tone: "text" | "audio"
  aria: string
  counts: string
  testId: string
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1">
        <PlanBar label={label} outer={outer} inner={inner} tone={tone} aria={aria} />
      </span>
      <span
        className="w-[62px] shrink-0 text-end text-[11px] tabular-nums text-muted-foreground"
        data-testid={testId}
      >
        {counts}
      </span>
    </span>
  )
}

/**
 * The Assign modal, hosted for the plan inspector.
 *
 * Its own component so `useProjectMembers` — a roster fetch — only runs when
 * the modal is actually open. Mounting it with the section would put one roster
 * read behind every unit a manager clicks through.
 */
function PlanAssignHost({
  target,
  lane,
  defaultLaneLabel,
  onClose,
}: {
  target: PlanAssignTarget
  lane: string
  /** AQU-728: the '' lane is a real language and must be named as one. */
  defaultLaneLabel: string
  onClose: () => void
}) {
  const { members } = useProjectMembers(target.projectId)
  // AssignModal wants FileReference; the plan only ever knows ids and names.
  // Same shim OrgLaneAssignModal writes, for the same reason: the modal reads
  // `type` for its scope wording and nothing else off these rows.
  const projectFiles = useMemo<FileReference[]>(
    () =>
      target.files.map((f) => ({
        id: f.id,
        name: f.name,
        type: "unknown" as FileType,
        createdAt: "",
        cellCount: 0,
      })),
    [target.files],
  )
  return (
    <AssignModal
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      projectId={target.projectId}
      activeFileId={target.activeFileId}
      projectFiles={projectFiles}
      targetLanes={target.targetLanes}
      // The lane the inspector is showing, so work assigned from here lands in
      // the language whose numbers the manager was just reading.
      defaultLane={lane}
      defaultLaneLabel={defaultLaneLabel}
      members={members}
      roleLevel={target.roleLevel}
      allowSelfAssignment={target.allowSelfAssignment}
      assignmentMinRole={target.assignmentMinRole}
      callerUserId={target.callerUserId}
      selectedCellIds={EMPTY_SELECTION}
      jwt={target.jwt}
      author={target.author}
      onAssigned={() => {
        target.onAssigned()
        onClose()
      }}
    />
  )
}
