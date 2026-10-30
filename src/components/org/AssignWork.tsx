import { useState, useEffect, useMemo } from "react"
import { AddProjectMembersHint } from "@/components/AddProjectMembersHint"
import { ROLE } from "@/lib/frontier/roles"
import { fetchProjectRoster, hasLanguageWorker, partitionMembers, type ProjectMember } from "@/lib/frontier/members"
import { compareByCanonicalBookOrder, getBookName } from "@/lib/file-labeling/bible-book-names"
import { createAssignment, getFileChapters } from "@/lib/sync/assignments"
import {
  buildLaneItems,
  initialAssignmentLane,
  laneIdForTag,
  lanesStaffedBy,
  laneTagForAssignment,
  type AssignLaneOption,
  type TeamLaneAttachment,
} from "@/lib/sync/assignment-lane"
import { canSubmitAssignment } from "@/lib/sync/role-policy"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DatePicker,
  dateToDeadlineString,
} from "@/components/ui/date-picker"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select"
import { useT } from "@/lib/i18n/I18nProvider"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { AssignKindField } from "@/components/AssignKindField"
import type { AssignmentKind } from "@/lib/sync/assignments"
import type { OverlapScope } from "@/lib/sync/assignment-overlap"
import { useAssignmentOverlap } from "@/hooks/useAssignmentOverlap"
import { AssignmentOverlapNotice } from "./AssignmentOverlapNotice"

/**
 * Manager affordance (project_lead+) on the project overview: assign a book or
 * chapter scope to a project member. Collapsed to an "Assign…" button until
 * opened; emits one assignment.create on submit. Book scope = whole file;
 * chapter scope = one or more real chapters checked from the file's chapter
 * list (each the canonical_ref prefix, e.g. "GEN 1", matched server-side via
 * LIKE). AQU-677: post-editors work contiguous chapter runs, so the chapter
 * picker is multi-select — every checked chapter lands in a single
 * assignment.create's `scope[]` (one assignment, one deadline, one progress
 * bar across the run). Checking none = whole book; the member selector stays
 * single-select.
 */
/**
 * AQU-678: the "Book" dropdown must list every book fully spelled out and in
 * canonical position, matching the sidebar. A file's `name` can be an
 * abbreviation or a locale rename (two data sources — see the issue), so we
 * resolve the canonical English book name from its stable `bookCode` when we
 * have one and fall back to the raw `name` for non-scripture files. Sorting on
 * the resolved label keeps a book like Ezekiel in its canonical slot even when
 * its file name is a non-canonical abbreviation the ordinal lookup can't match.
 */
function bookLabel(f: { name: string; bookCode?: string }): string {
  return (f.bookCode ? getBookName(f.bookCode) : undefined) ?? f.name
}

export interface AssignWorkProps {
  projectId: string
  /** Files in the project (book = one file). */
  files: { id: string; name: string; bookCode?: string }[]
  jwt: string
  /** Manager's username — stamped as the event author (server re-verifies). */
  author: string
  /** Caller authority used by the optional self-assignment carve-out. */
  roleLevel?: number
  allowSelfAssignment?: boolean
  /** Org-configured floor for assigning work to anyone. */
  assignmentMinRole?: number
  /** Caller identity used to guarantee below-lead assignments target self. */
  callerUserId?: number | null
  /** Called after a successful assign so the parent can refresh rollups. */
  onAssigned?: () => void
  /**
   * Lane tag the manager arrived from. `null` or omitted is the All tab:
   * several lanes pre-fill nothing. `''` is the default lane. One lane names
   * itself either way.
   */
  arrivedLane?: string | null
  /** Tags the field offers. `''` is the default lane. Omitted → that lane only. */
  laneTags?: readonly string[]
  /**
   * AQU-1977: the project's own target lanes, in order (`assignLaneOptions`).
   * When given they replace `laneTags` and no "Default language" is invented.
   */
  lanes?: readonly AssignLaneOption[]
  laneLabels?: Readonly<Record<string, string>>
  defaultLaneLabel?: string
  /**
   * Target lane rows. The chosen row's id is what `assignment.create` sends.
   * Absent before the lane rows exist; the tag still goes out.
   */
  laneRows?: readonly { id: string; legacyTag: string | null }[]
  /**
   * AQU-1994: the project's lanes at least one of its people is on. The field
   * offers only these, so a manager cannot route work to a language nobody on
   * the project can work in. `null`/omitted is "the server did not say" — not
   * "nobody" — and leaves the list as it was.
   */
  staffedLaneIds?: ReadonlySet<string> | readonly string[] | null
  /**
   * AQU-2047: each attached team's lane checks. A lane stays when any attached
   * team is tied to it. `lanesExplicit: false` is tied to every current target
   * lane. `null`, omitted, or `[]` (no attached team) leaves the list as it
   * was — absence is not "no lanes". Applied with staffing: a lane must pass
   * both when both are present.
   */
  teamLanes?: readonly TeamLaneAttachment[] | null
  /** Called when the panel is opened, so staffing and team lanes can be re-read. */
  onOpen?: () => void
}

const DEFAULT_ROLE_LEVEL = 500
const DEFAULT_ASSIGNMENT_MIN_ROLE = 500

/** A person in the Assignee list; the empty first row has no user. */
interface AssigneeOption extends SearchSelectOption {
  userId?: number
  username?: string
}

export function AssignWork({
  projectId,
  files,
  jwt,
  author,
  roleLevel = DEFAULT_ROLE_LEVEL,
  allowSelfAssignment = false,
  assignmentMinRole = DEFAULT_ASSIGNMENT_MIN_ROLE,
  callerUserId = null,
  onAssigned,
  arrivedLane = null,
  laneTags,
  lanes,
  laneLabels,
  defaultLaneLabel,
  laneRows,
  staffedLaneIds,
  teamLanes,
  onOpen,
}: AssignWorkProps) {
  const t = useT()
  const isSelfAssignMode = roleLevel < assignmentMinRole
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [assigneeId, setAssigneeId] = useState<number | "">(
    isSelfAssignMode && callerUserId != null ? callerUserId : "",
  )
  const [fileId, setFileId] = useState(files[0]?.id ?? "")
  const [selectedChapters, setSelectedChapters] = useState<string[]>([])
  const [chapters, setChapters] = useState<string[]>([])
  const [deadlineDate, setDeadlineDate] = useState<Date | undefined>(undefined)
  // AQU-1969: Translate (the assignment as it always was) unless chosen.
  const [kind, setKind] = useState<AssignmentKind>("translate")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const laneItems = useMemo(
    () =>
      buildLaneItems({
        lanes,
        targetLanes: laneTags,
        laneLabels,
        defaultLaneLabel,
        defaultLaneFallback: t("dialog.assign.defaultLaneFallback"),
        staffedLaneIds,
        teamLanes,
      }),
    [lanes, laneTags, laneLabels, defaultLaneLabel, staffedLaneIds, teamLanes, t],
  )
  // AQU-1994: nobody on the project is on any of its lanes. There is nothing
  // truthful to offer, so the field says so and Assign is refused rather than
  // listing languages no one can work in. Asked of staffing alone, so the
  // legacy `laneTags` shape (a project with no lane rows) is untouched.
  const noStaffedLanes =
    Boolean(lanes?.length) && lanesStaffedBy(lanes ?? [], staffedLaneIds).length === 0
  // undefined = the arrival rule; a string or null is the manager's own pick.
  // Reset when the panel opens or the lane they arrived from changes, so a
  // previous choice doesn't survive into the All tab.
  const arrivalKey = `${open ? "open" : "closed"}:${arrivedLane ?? "all"}:${laneItems.map((item) => item.value).join("\0")}`
  const [lanePick, setLanePick] = useState<{ key: string; value: string | null } | null>(null)
  if (lanePick?.key !== arrivalKey) {
    setLanePick({ key: arrivalKey, value: initialAssignmentLane(laneItems, arrivedLane) })
  }
  const selectedLane = lanePick?.key === arrivalKey ? lanePick.value : initialAssignmentLane(laneItems, arrivedLane)
  function chooseLane(value: string | null) {
    setLanePick({ key: arrivalKey, value })
  }
  // AQU-1308: why the roster is empty, when it is empty for a reason.
  const [rosterError, setRosterError] = useState<"hidden" | "load-failed" | null>(null)
  // AQU-2194: whether the roster fetch for this opening has answered, so the
  // "nobody else is on this project" line never flashes before it does.
  const [rosterLoaded, setRosterLoaded] = useState(false)

  // AQU-582 / AQU-678: list books in canonical Bible reading order (Genesis →
  // Revelation) rather than the incoming prop order, matching the sidebar and
  // the Assign modal, and label each with its fully spelled-out canonical name
  // (via bookLabel) so abbreviations don't leak through. Sorting on the resolved
  // label keeps every book in its canonical slot; non-book files fall back to
  // alphabetic via the shared comparator.
  const sortedFiles = useMemo(
    () =>
      files
        .map((f) => ({ ...f, label: bookLabel(f) }))
        .sort((a, b) => compareByCanonicalBookOrder(a.label, b.label)),
    [files],
  )

  // AQU-676: fetch the project's effective roster (same source AssignModal's
  // hosts use), not the org roster — an org roster both floods the picker with
  // org-baseline-only people and misses project-only invitees (AQU-474).
  // Roster-hidden / no-access resolve to an empty list, failing closed.
  // AQU-1308: a failed roster fetch must never collapse into a silent empty
  // "Select member…". The three non-ok outcomes are kept apart so the picker
  // can say which one happened: `roster-hidden` is org policy (actionable —
  // ask an owner), `no-access` / a thrown error is a load failure.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setRosterError(null)
    setRosterLoaded(false)
    fetchProjectRoster(jwt, projectId)
      .then((r) => {
        if (cancelled) return
        setMembers(r.kind === "ok" ? r.members : [])
        setRosterLoaded(true)
        if (r.kind === "roster-hidden") setRosterError("hidden")
        else if (r.kind === "no-access") setRosterError("load-failed")
      })
      .catch((e) => {
        if (cancelled) return
        setMembers([])
        setRosterError("load-failed")
        setRosterLoaded(true)
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [open, jwt, projectId])

  // AQU-676: the assignee picker must list only the project's own members,
  // never everyone with org-baseline access. partitionMembers (AQU-454) keeps
  // only members with a project-specific path (override / group / creator);
  // org-baseline-only members drop out. Self-assign mode is exempt (the caller
  // claims work for themselves) — it filters the raw roster to the caller.
  const eligibleMembers = useMemo(
    () => partitionMembers(members).projectMembers,
    [members],
  )
  const effectiveCallerUserId =
    callerUserId ?? members.find((member) => member.username === author)?.userId ?? null
  // AQU-2194: nobody on the project to give language work to leaves the picker
  // without a linguist and no word why (AssignModal's showStaffHint, same rule).
  const showStaffHint =
    rosterLoaded &&
    !isSelfAssignMode &&
    !rosterError &&
    !hasLanguageWorker(eligibleMembers, effectiveCallerUserId)

  useEffect(() => {
    if (isSelfAssignMode && effectiveCallerUserId != null) {
      setAssigneeId(effectiveCallerUserId)
    }
  }, [isSelfAssignMode, effectiveCallerUserId])

  // The two searchable lists (AQU-2260). The first assignee row is the empty
  // "Select member…" choice, as it was in the plain dropdown.
  const assigneeOptions = useMemo<AssigneeOption[]>(
    () =>
      isSelfAssignMode
        ? members
            .filter((m) => m.userId === effectiveCallerUserId)
            .map((m) => ({
              value: String(m.userId),
              label: t("dialog.assign.assigneeSelfSuffix", { username: m.username }),
              userId: m.userId,
              username: m.username,
            }))
        : [
            { value: "", label: t("dialog.assign.selectMemberPlaceholder") },
            // AQU-676: project members only — org-baseline-only people are excluded.
            ...eligibleMembers.map((m) => ({
              value: String(m.userId),
              label: m.username,
              userId: m.userId,
              username: m.username,
            })),
          ],
    [isSelfAssignMode, members, eligibleMembers, effectiveCallerUserId, t],
  )
  const bookOptions = useMemo(
    () => sortedFiles.map((f) => ({ value: f.id, label: f.label })),
    [sortedFiles],
  )


  // Load the selected file's chapters for the picker; clear the checked
  // chapters when the file changes so stale chapters can't leak across books.
  useEffect(() => {
    if (!open || !fileId) return
    let cancelled = false
    setSelectedChapters([])
    getFileChapters(jwt, projectId, fileId)
      .then((cs) => { if (!cancelled) setChapters(cs) })
      .catch(() => { if (!cancelled) setChapters([]) })
    return () => { cancelled = true }
  }, [open, fileId, jwt, projectId])

  // Keep the checked chapters in canonical (server-natural-sorted) order
  // regardless of click order — drives both the scope[] and the label.
  const orderedChosen = useMemo(
    () => chapters.filter((ch) => selectedChapters.includes(ch)),
    [chapters, selectedChapters],
  )
  const allChaptersChecked =
    chapters.length > 0 && orderedChosen.length === chapters.length

  function toggleChapter(ch: string, checked: boolean) {
    setSelectedChapters((prev) =>
      checked ? [...prev, ch] : prev.filter((c) => c !== ch),
    )
  }

  async function submit() {
    if (assigneeId === "") {
      setError(t("org.assignWork.chooseAssignee"))
      return
    }
    if (!fileId) {
      setError(t("org.assignWork.chooseFile"))
      return
    }
    // AQU-676 defense-in-depth: the picker already hides org-baseline-only
    // members, but re-check on submit so a stale/forced selection can't route
    // an assignment to someone outside the project.
    if (!isSelfAssignMode && !eligibleMembers.some((m) => m.userId === Number(assigneeId))) {
      setError(t("dialog.assign.error.notProjectMember"))
      return
    }
    if (!canSubmitAssignment(
      roleLevel,
      allowSelfAssignment,
      effectiveCallerUserId,
      Number(assigneeId),
      assignmentMinRole,
    )) {
      setError(t("dialog.assign.error.selfOnly"))
      return
    }
    if (noStaffedLanes) {
      setError(t("org.assignWork.noStaffedLanes"))
      return
    }
    // One lane names itself. Several lanes pre-fill only from the tab the
    // manager arrived from; the All tab pre-fills nothing and cannot submit.
    const chosenLane = laneItems.length === 1 ? laneItems[0]!.value : selectedLane
    if (!chosenLane) {
      setError(t("org.assignWork.chooseLane"))
      return
    }
    const targetLang = laneTagForAssignment(chosenLane)
    const laneId = laneIdForTag(targetLang, laneRows)
    // AQU-678: label the assignment with the spelled-out canonical book name.
    const fileName = sortedFiles.find((f) => f.id === fileId)?.label ?? "file"
    // AQU-677: zero checked chapters = whole book (unchanged single-book path);
    // one or more = a single chapters-scope assignment listing every chapter.
    const chosen = orderedChosen
    const scopeKind = chosen.length > 0 ? "chapters" : "books"
    const scope =
      chosen.length > 0 ? chosen.map((ch) => ({ fileId, chapter: ch })) : [{ fileId }]
    const scopeLabel =
      chosen.length > 0 ? `${fileName} · ${chosen.join(", ")}` : fileName
    const deadline = deadlineDate ? dateToDeadlineString(deadlineDate) : ""
    setBusy(true)
    setError(null)
    try {
      await createAssignment({
        jwt,
        projectId,
        fileId,
        author,
        assigneeUserId: Number(assigneeId),
        scope,
        scopeKind,
        scopeLabel,
        ...(targetLang ? { targetLang } : {}),
        ...(laneId ? { laneId } : {}),
        deadline: deadline || null,
        kind,
      })
      setSelectedChapters([])
      setDeadlineDate(undefined)
      setKind("translate")
      setOpen(false)
      onAssigned?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // AQU-1510: say so when this would assign someone lines they already hold.
  // No chapters ticked is the whole book, the same reading the submit takes.
  const overlapScope = useMemo<OverlapScope | null>(
    () => (orderedChosen.length > 0 ? { kind: "chapters", chapters: orderedChosen } : { kind: "file" }),
    [orderedChosen],
  )
  const overlapFileIds = useMemo(() => (open && fileId ? [fileId] : []), [open, fileId])
  const overlapMember = assigneeId === "" ? null : members.find((m) => m.userId === Number(assigneeId)) ?? null
  const overlaps = useAssignmentOverlap({
    jwt,
    projectId,
    fileIds: overlapFileIds,
    scope: overlapScope,
    assigneeUserId: overlapMember?.userId ?? null,
    lane: laneItems.length === 1 ? laneItems[0]!.value : selectedLane,
    kind,
  })

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => { setOpen(true); onOpen?.() }}
      >
        {t("org.assignWork.assignButtonLabel")}
      </Button>
    )
  }

  return (
    <div role="group" aria-label={t("dialog.assign.title")} className="mt-3 w-full rounded-md border p-3">
      <FieldGroup className="gap-4">
        <AssignKindField id="assign-work-kind" value={kind} onChange={setKind} disabled={busy} />
        <Field>
          <FieldLabel htmlFor={laneItems.length > 1 ? "assign-work-lane" : undefined}>
            {t("dialog.assign.laneLabel")}
          </FieldLabel>
          {noStaffedLanes ? (
            <FieldError data-testid="assign-work-no-staffed-lanes">
              {t("org.assignWork.noStaffedLanes")}
            </FieldError>
          ) : laneItems.length === 1 ? (
            <p data-testid="assign-work-lane-fixed" className="text-sm">
              {laneItems[0]!.label}
            </p>
          ) : (
            <Select
              items={[
                { value: "", label: t("org.assignWork.chooseLane") },
                ...laneItems,
              ]}
              value={selectedLane ?? ""}
              onValueChange={(v) => chooseLane(v ? v : null)}
              disabled={busy}
            >
              <SelectTrigger id="assign-work-lane" data-testid="assign-work-lane">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="">{t("org.assignWork.chooseLane")}</SelectItem>
                  {laneItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="assign-work-assignee">{t("org.assignWork.assigneeLabel")}</FieldLabel>
            {/* AQU-2260: a search box, since the people list grows with the team. */}
            <SearchSelect
              id="assign-work-assignee"
              options={assigneeOptions}
              value={assigneeId === "" ? "" : String(assigneeId)}
              onValueChange={(v) => setAssigneeId(v === "" ? "" : Number(v))}
              disabled={busy || isSelfAssignMode}
              renderOption={(o) =>
                o.userId == null ? (
                  o.label
                ) : (
                  <UsernameWithAvatar
                    userId={o.userId}
                    username={o.username ?? o.label}
                    label={isSelfAssignMode ? o.label : undefined}
                    size="xs"
                    menuSafe
                    nameClassName="text-sm font-normal"
                  />
                )
              }
            />
            {isSelfAssignMode && (
              <FieldDescription>
                {t("org.assignWork.selfAssignNote")}
              </FieldDescription>
            )}
            {showStaffHint && (
              <AddProjectMembersHint projectId={projectId} testId="assign-work-staff-hint" canAddPeople={roleLevel >= ROLE.MAINTAINER} />
            )}
            {/* AQU-1308: name the failure right under the picker it emptied. */}
            {rosterError && (
              <FieldError>
                {rosterError === "hidden"
                  ? t("org.assignWork.rosterHiddenError")
                  : t("org.assignWork.rosterLoadError")}
              </FieldError>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="assign-work-book">{t("org.assignWork.bookLabel")}</FieldLabel>
            {/* AQU-2260: up to 66 books, so a search box. */}
            <SearchSelect
              id="assign-work-book"
              options={bookOptions}
              value={fileId}
              onValueChange={setFileId}
              disabled={busy}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="assign-work-chapters">{t("editor.milestone.vocab.chapterPlural")}</FieldLabel>
            {chapters.length === 0 ? (
              <FieldDescription>
                {t("org.assignWork.wholeBookNoChapters")}
              </FieldDescription>
            ) : (
              <>
                <div
                  className="mb-1 flex items-center justify-between text-xs text-muted-foreground"
                >
                  <span>
                    {orderedChosen.length === 0
                      ? t("org.assignWork.wholeBookNoneChecked")
                      : t("org.assignWork.chaptersSelectedCount", { count: orderedChosen.length })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto px-1 py-0 text-xs"
                    disabled={busy}
                    onClick={() =>
                      setSelectedChapters(allChaptersChecked ? [] : [...chapters])
                    }
                  >
                    {allChaptersChecked ? t("org.assignWork.clearAllChapters") : t("common.selectAll")}
                  </Button>
                </div>
                <div
                  id="assign-work-chapters"
                  role="group"
                  aria-label={t("editor.milestone.vocab.chapterPlural")}
                  className="max-h-40 overflow-y-auto rounded-md border p-2"
                >
                  {chapters.map((ch) => (
                    <label
                      key={ch}
                      className="flex items-center gap-2 py-1 text-sm"
                    >
                      <Checkbox
                        checked={selectedChapters.includes(ch)}
                        onCheckedChange={(c) => toggleChapter(ch, c === true)}
                        disabled={busy}
                      />
                      {ch}
                    </label>
                  ))}
                </div>
              </>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="assign-work-deadline">
              {t("dialog.assign.deadlineLabel")}
            </FieldLabel>
            <DatePicker
              id="assign-work-deadline"
              value={deadlineDate}
              onChange={setDeadlineDate}
              disabled={busy}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={busy || noStaffedLanes}
          >
            {t("dialog.assign.submit")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => { setOpen(false); setError(null) }}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
        </div>
        <AssignmentOverlapNotice
          overlaps={overlaps}
          username={overlapMember?.username ?? ""}
          fileName={(id) => sortedFiles.find((f) => f.id === id)?.label ?? id}
        />
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
    </div>
  )
}
