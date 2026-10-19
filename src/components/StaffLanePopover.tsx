// AQU-538 §3.4 — one-gesture staffing control. "Add María as reviewer on
// Spanish" in a single confirm: pick a person from the org roster, pick a
// role (reviewer/contributor only — see AQU-2004 below), confirm. Confirm
// then:
//   1. ensures project membership at that role (skips the POST when the
//      person already holds >= that role — never downgrades someone);
//   2. merges a `{ kind: 'lane', value: lane }` scope onto whatever scopes
//      they already have (fetched first, so other lanes/files survive).
//
// Reused verbatim (pinned prop contract) by OrgHome lane sub-rows,
// ProjectOverview lane rows, and the members matrix.
//
// AQU-731 — the roster this popover searches is the ORG roster, and there are
// four ways it can come back empty that are not "your org has no members":
// the org id isn't known yet/at all, the fetch is still in flight, org policy
// hides the roster (AQU-485), or the caller simply isn't an org member (a
// project admin staffing a lane need not be one). All four used to render the
// single line "No one in your organization yet.", which is why the control was
// reported as doing nothing: the popover opened, claimed the org was empty,
// and offered no way forward. Each state now names itself and points at the
// project-invite path, which works without org-roster access.
//
// AQU-1998 — the popover is also where a lane staffing is UNDONE. It lists
// the people already scoped to this lane (the same set the lane's People
// column shows) with a Remove beside each, so the undo lives next to the do
// instead of in the org Members → Matrix tab. Remove rewrites that one
// member's scopes without this lane's row: their other lanes and any file
// limits are read back first and written through untouched. Someone whose
// ONLY lane is this one is guarded, not removed — see StaffedLaneMembers.
//
// AQU-1999 — the two cases AQU-1998 left open are decided here:
//
//   1. The LAST lane stays blocked. An empty lane list is the
//      backward-compatible "every lane" state, so a real "no lanes" would be a
//      server change; taking the person off the project is a different
//      gesture, and it lives where project membership does. The guard is kept
//      and its note worded more plainly.
//   2. Open assignments in the lane are CLOSED with the removal. A person who
//      can no longer see a lane cannot work its assignments either, so leaving
//      them open strands work nobody is told about. So Remove first reads what
//      the person holds open in this lane: none and it removes in one press,
//      as before; otherwise it asks, naming the count, and only a confirm
//      emits the `assignment.unassign` events and then saves the scopes.
//      Completed/validated work is untouched — unassign is a soft close.
//
// Order matters in that confirm: the last-lane guard is re-checked (a read)
// BEFORE anything is closed, so a refused removal never leaves assignments
// closed behind it; and the closes land before the scope PUT, so a failure
// there leaves the person still holding the lane their work sits in.
//
// Maintainers and above (effective role >= 600) can't be lane-scoped — the
// server rejects PUT scopes for them with 400 (LANE_SCOPE_ABOVE_CEILING_ERROR),
// since they see every language by design. A project lead (500) CAN be
// limited to lanes since AQU-1813. The role select here only ever offers
// reviewer/contributor, and the add never lowers anyone, so the person keeps
// the higher of their current role and the picked one — that is the role the
// sentence names (AQU-2027). Someone the roster already shows at 600+ gets a
// note instead of an Add; if the server refuses anyway (a stale roster), the
// same note is shown rather than the raw error.
//
// AQU-2004 — this popover offers NO lead path. It used to end in a dashed box
// reading "Need broader access? Leads see all languages." beside an "Add as
// lead — every lane" link, and since AQU-1813 both sentences are false: a
// project lead sees a lane only where they hold a grant for it, and the link
// granted either the lanes the person already had or only the lanes that
// existed at that moment — never "every lane". Promoting someone to lead
// means choosing their lanes, so it belongs in the project's Members / Share
// flows where lanes are explicit, not behind a one-click link in a
// lane-scoped control. Keep this surface to the lane you clicked.

import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { Search, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { RoleSelect } from "@/components/RoleSelect"
import { StaffedLaneMembers, type StaffedLanePerson } from "@/components/StaffedLaneMembers"
import { ROLE, roleName, roleDescription } from "@/lib/frontier/roles"
import { LANE_SCOPE_ABOVE_CEILING_ERROR } from "@/lib/lanes/scope-ids"
import { useOrgMembers } from "@/hooks/useOrg"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { addProjectMember } from "@/lib/frontier/members"
import {
  fetchMemberLaneAssignments,
  fetchMemberScopes,
  putMemberScopes,
  type MemberLaneAssignment,
  type MemberScope,
} from "@/lib/sync/member-scopes"
import { unassignAssignment } from "@/lib/sync/assignments"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { GrantScopeNotice } from "@/components/GrantScopeNotice"
import { toast } from "@/components/ui/toast"
import { describeGrant, grantButtonLabel, grantProjectName } from "@/lib/access/grant-scope-sentence"

/** Pinned contract — wave-B agents import this exactly. */
export interface StaffLanePopoverProps {
  projectId: string
  lane: string
  /**
   * AQU-1607: the lane's id (`lanes.id`), which is what a lane scope stores.
   * Pass it wherever the caller's row has it — a project can hold two lanes
   * of one language, and only the id says which one is being staffed. Absent,
   * the server resolves `lane` and refuses a tag that fits two lanes.
   */
  laneId?: string | null
  laneLabel: string
  /** Project display name for the grant sentence. Omitted → "this project". */
  projectName?: string | null
  orgId: number | null
  trigger?: ReactNode
  onDone?: () => void
  /** Controlled open — pair with `onOpenChange` when launching from a ⋯ menu. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * Visually hide the trigger (sr-only). Use when the popover is opened from a
   * row ⋯ menu and only needs an anchor in the actions cell.
   */
  anchorOnly?: boolean
}

/**
 * Whether a stored scope row names the lane this popover is staffing.
 *
 * AQU-1607: a lane scope holds `lanes.id`, but rows written before that hold
 * the language tag, so both spellings of the same lane count — the rule the
 * add path already applies when it merges a lane scope on.
 */
function scopeNamesLane(scope: MemberScope, laneValue: string, laneTag: string): boolean {
  return scope.kind === "lane" && (scope.value === laneValue || scope.value === laneTag)
}

/** The staffing role select is intentionally scoped to reviewer/contributor
 * only — raising someone to lead+ means choosing their lanes explicitly, so it
 * lives in the project's Members / Share flows (AQU-2004, see file header). */
const STAFFABLE_ROLES: readonly number[] = [ROLE.REVIEWER, ROLE.CONTRIBUTOR]

const MAX_RESULTS = 20

type Phase = "idle" | "submitting" | "done" | "error"

/** AQU-731: the ways the org roster can be unsearchable, each with its own
 * message. `null` (see `rosterBlocked`) means the roster is usable. */
type RosterBlocked = "no-org" | "loading" | "hidden" | "no-access" | "error"

/** `error` is absent on purpose — that branch shows the server's own message
 * and falls back to `rosterLoadFailed`, so it is handled at the call site. */
const ROSTER_BLOCKED_KEY = {
  "no-org": "org.staffLanePopover.rosterNoOrg",
  loading: "org.staffLanePopover.rosterLoading",
  hidden: "org.staffLanePopover.rosterHidden",
  "no-access": "org.staffLanePopover.rosterNoAccess",
} as const satisfies Record<Exclude<RosterBlocked, "error">, string>

export function StaffLanePopover({
  projectId,
  lane,
  laneId,
  laneLabel,
  projectName,
  orgId,
  trigger,
  onDone,
  open: openProp,
  onOpenChange,
  anchorOnly = false,
}: StaffLanePopoverProps) {
  const { t, locale } = useI18n()
  const location = useLocation()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const {
    members: orgMembers,
    isLoading: rosterLoading,
    error: rosterError,
    rosterHidden,
    rosterAccessDenied,
  } = useOrgMembers(orgId)
  const { members: projectMembers, refresh: refreshProjectMembers } = useProjectMembers(projectId)

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : uncontrolledOpen
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<{ userId: number; username: string } | null>(null)
  const [role, setRole] = useState<number>(ROLE.REVIEWER)
  const [phase, setPhase] = useState<Phase>("idle")
  const [message, setMessage] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  /**
   * AQU-1998: who is already staffed on this lane. `null` until the first
   * scope read for an open popover has come back, so "nobody yet" and "not
   * loaded" never render the same.
   */
  const [staffed, setStaffed] = useState<StaffedLanePerson[] | null>(null)
  const [removingUserId, setRemovingUserId] = useState<number | null>(null)
  const [removeError, setRemoveError] = useState<{ userId: number; message: string } | null>(null)
  /**
   * AQU-1999: a removal held at the confirmation, with the open assignments it
   * will close. `null` whenever nothing is awaiting a confirm — including
   * right after one, so the question is never asked twice for one removal.
   */
  const [pendingRemoval, setPendingRemoval] = useState<{
    userId: number
    assignments: MemberLaneAssignment[]
  } | null>(null)
  /** Bumped after a staffing change so the list re-reads the scopes. */
  const [staffedNonce, setStaffedNonce] = useState(0)

  /** The value a scope row for this lane holds — its id where the caller knows it. */
  const laneValue = laneId || lane

  /**
   * Why the org roster can't be searched, or null when it can. Ordered most
   * specific first: a missing org id means the fetch never even fired, so it
   * outranks the loading flag (which stays false in that case).
   *
   * AQU-1798: a hidden or failed org roster does not hide people who are
   * already on this project. A direct invite is staffed onto this lane from
   * here; the project-members page is only for someone on neither list.
   */
  const rosterBlocked: RosterBlocked | null =
    orgId == null
      ? "no-org"
      : rosterLoading
        ? "loading"
        : rosterHidden
          ? "hidden"
          : rosterAccessDenied
            ? "no-access"
            : rosterError !== null
              ? "error"
              : null

  /**
   * Maintainers and above are never lane-scoped — they see every language by
   * design, so they belong to no lane row and can't be removed from one (the
   * server refuses to scope them at all). A project lead can be limited to
   * lanes (AQU-1813), so the list below is drawn from the members BELOW
   * maintainer, exactly like the lane's People column (AQU-2027).
   */
  const scopableMembers = useMemo(
    () => projectMembers.filter((m) => m.role.level < ROLE.MAINTAINER),
    [projectMembers],
  )
  // Joined ids rather than the array: the roster hook hands back a new array
  // on every refresh, and re-running this effect for an unchanged membership
  // would re-fetch every member's scopes on each render.
  const scopableKey = scopableMembers.map((m) => m.userId).join(",")

  // Read each scopable member's scopes while the popover is open and keep the
  // ones scoped to this lane. A failed read counts as "unscoped" — the same
  // tolerance the People column applies — never as "staffed here", so one bad
  // fetch can't offer a Remove that would rewrite scopes we couldn't see.
  useEffect(() => {
    if (!open || !jwt) {
      return
    }
    let alive = true
    void (async () => {
      const rows = await Promise.all(
        scopableMembers.map(async (m) => {
          const scopes = (await fetchMemberScopes(jwt, projectId, m.userId)) ?? []
          const laneScopes = scopes.filter((s) => s.kind === "lane")
          return {
            person: { userId: m.userId, username: m.username, laneCount: laneScopes.length },
            onThisLane: laneScopes.some((s) => scopeNamesLane(s, laneValue, lane)),
          }
        }),
      )
      // An empty roster lands here too, as an empty list rather than a
      // still-loading one.
      if (alive) setStaffed(rows.filter((r) => r.onThisLane).map((r) => r.person))
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopableKey stands in for scopableMembers
  }, [open, jwt, projectId, scopableKey, laneValue, lane, staffedNonce])

  const searchPool = useMemo(() => {
    const orgIds = new Set(orgMembers.map((m) => m.userId))
    const onProjectOnly = projectMembers
      .filter((m) => !orgIds.has(m.userId))
      .map((m) => ({ userId: m.userId, username: m.username }))
    if (rosterBlocked !== null) return onProjectOnly
    return [
      ...orgMembers.map((m) => ({ userId: m.userId, username: m.username })),
      ...onProjectOnly,
    ]
  }, [orgMembers, projectMembers, rosterBlocked])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pool = q ? searchPool.filter((m) => m.username.toLowerCase().includes(q)) : searchPool
    return pool.slice(0, MAX_RESULTS)
  }, [searchPool, query])

  const blockSearch = rosterBlocked !== null && searchPool.length === 0

  // AQU-2027: the picked person's current role on the project, when the roster
  // has them. The add never lowers anyone, so they end up holding the higher
  // of that and the picked role; at maintainer or above no lane limit applies.
  const selectedLevel = selected
    ? (projectMembers.find((m) => m.userId === selected.userId)?.role.level ?? null)
    : null
  const seesEveryLane = selectedLevel !== null && selectedLevel >= ROLE.MAINTAINER
  const keepsRole = selectedLevel !== null && selectedLevel >= role
  const heldRole = keepsRole && selectedLevel !== null ? selectedLevel : role

  function reset() {
    setQuery("")
    setSelected(null)
    setRole(ROLE.REVIEWER)
    setPhase("idle")
    setMessage(null)
    setErrorMsg(null)
    // Drop the staffed list too: a reopened popover re-reads it rather than
    // showing who was on the lane when it was last closed.
    setStaffed(null)
    setRemovingUserId(null)
    setRemoveError(null)
    setPendingRemoval(null)
  }

  function handleOpenChange(next: boolean) {
    if (!controlled) setUncontrolledOpen(next)
    onOpenChange?.(next)
    if (!next) reset()
  }

  /** Ensures membership at >= targetRole, skipping the POST when the person
   * already holds it — an explicit downgrade is never issued from here. */
  async function ensureMembership(userId: number, username: string, targetRole: number) {
    const existing = projectMembers.find((m) => m.userId === userId)
    if (existing && existing.role.level >= targetRole) return
    if (!jwt) throw new Error("Sign in to manage membership.")
    // A new member below project lead has to name this lane on the add.
    // Sending it afterwards, only as a scope, used to grant every lane first.
    // A lead stays unscoped: the role already sees every lane.
    if (targetRole < ROLE.PROJECT_LEAD) {
      await addProjectMember(jwt, projectId, username, targetRole, {
        scopeLanes: [laneId || lane],
      })
    } else {
      await addProjectMember(jwt, projectId, username, targetRole)
    }
  }

  function mergeLaneScope(existing: MemberScope[]): MemberScope[] {
    // AQU-1607: write the lane id when we have it, and drop a row that named
    // this same lane the old way so the member ends up with one scope for it.
    const value = laneValue
    return [...existing.filter((s) => !scopeNamesLane(s, value, lane)), { kind: "lane", value }]
  }

  /**
   * Take this lane off one member's scopes, leaving everything else as it was,
   * after closing the assignments this removal was confirmed to close.
   *
   * Their scopes are re-read first: the PUT is a replace-set, and one built
   * from the rows this popover loaded when it opened would quietly restore a
   * lane or file limit changed since. If what's left names no lane at all the
   * removal is refused rather than saved — an empty lane list means every
   * lane, so it would widen the person's access (the guard normally keeps the
   * button disabled; this catches the member's other lanes going away while
   * the popover sat open). That refusal is checked BEFORE any assignment is
   * closed, so nothing is closed for a removal that does not happen.
   *
   * AQU-1999: the assignments then close (a soft `assignment.unassign`, which
   * leaves finished work and its validations alone) ahead of the scope PUT. A
   * failure part-way leaves the person on the lane, where they can still
   * reach whatever is still assigned to them, and the row shows the error.
   */
  async function applyRemoval(person: StaffedLanePerson, assignments: MemberLaneAssignment[]) {
    if (!jwt) return
    try {
      const existing = (await fetchMemberScopes(jwt, projectId, person.userId)) ?? []
      const remaining = existing.filter((s) => !scopeNamesLane(s, laneValue, lane))
      if (!remaining.some((s) => s.kind === "lane")) {
        setRemoveError({ userId: person.userId, message: t("org.staffLanePopover.lastLaneRefused") })
        setPendingRemoval(null)
        setStaffed(
          (prev) =>
            prev?.map((p) => (p.userId === person.userId ? { ...p, laneCount: 1 } : p)) ?? prev,
        )
        return
      }
      for (const assignment of assignments) {
        await unassignAssignment({
          jwt,
          projectId,
          fileId: assignment.fileId,
          author: session?.username ?? "",
          assignmentId: assignment.assignmentId,
        })
      }
      await putMemberScopes(jwt, projectId, person.userId, remaining)
      // Only now does the row go: a failed save leaves the person listed.
      setPendingRemoval(null)
      setStaffed((prev) => (prev ?? []).filter((p) => p.userId !== person.userId))
      await refreshProjectMembers()
      onDone?.()
    } catch (err) {
      setRemoveError({
        userId: person.userId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Remove pressed. What the person holds open in this lane decides whether
   * anything is saved now: nothing open and the removal goes through in this
   * one press (AQU-1999 — no extra step for the common case); otherwise the
   * row asks first, naming the work the removal will close.
   *
   * A read that FAILS refuses the removal instead of assuming zero. Treating
   * "couldn't tell" as "nothing open" is how an assignment ends up in a lane
   * its holder can no longer open, which is the whole point of this check.
   */
  async function handleRemove(person: StaffedLanePerson) {
    if (!jwt) return
    setRemovingUserId(person.userId)
    setRemoveError(null)
    try {
      const open = await fetchMemberLaneAssignments(jwt, projectId, person.userId, laneValue)
      if (open === null) {
        setRemoveError({
          userId: person.userId,
          message: t("org.staffLanePopover.assignmentCheckFailed", { name: person.username }),
        })
        return
      }
      if (open.length > 0) {
        setPendingRemoval({ userId: person.userId, assignments: open })
        return
      }
      await applyRemoval(person, [])
    } finally {
      setRemovingUserId(null)
    }
  }

  /** The confirm on a removal that closes assignments — see applyRemoval. */
  async function handleConfirmRemove(person: StaffedLanePerson) {
    if (!pendingRemoval || pendingRemoval.userId !== person.userId) return
    const assignments = pendingRemoval.assignments
    setRemovingUserId(person.userId)
    setRemoveError(null)
    try {
      await applyRemoval(person, assignments)
    } finally {
      setRemovingUserId(null)
    }
  }

  async function handleConfirm() {
    if (!selected || !jwt || seesEveryLane) return
    setPhase("submitting")
    setErrorMsg(null)
    try {
      await ensureMembership(selected.userId, selected.username, role)
      try {
        const existingScopes = (await fetchMemberScopes(jwt, projectId, selected.userId)) ?? []
        await putMemberScopes(jwt, projectId, selected.userId, mergeLaneScope(existingScopes))
      } catch (scopeErr) {
        const text = scopeErr instanceof Error ? scopeErr.message : String(scopeErr)
        if (text.startsWith(LANE_SCOPE_ABOVE_CEILING_ERROR)) {
          // The person's effective role is already maintainer+ (the roster
          // we checked was stale) — the server is correctly refusing to scope
          // them. That's not a failure: they already see every language.
          await refreshProjectMembers()
          setPhase("done")
          setMessage(t("org.staffLanePopover.alreadySeesEveryLanguage", { name: selected.username }))
          onDone?.()
          return
        }
        throw scopeErr
      }
      await refreshProjectMembers()
      // AQU-1998: the person just staffed belongs in the list above, so
      // re-read the scopes rather than leaving it as it was on open.
      setStaffedNonce((n) => n + 1)
      setPhase("done")
      const sentence = describeGrant(t, {
        names: [selected.username],
        roleLevel: heldRole,
        stays: keepsRole,
        scope: {
          kind: "project",
          projectName: grantProjectName(t, projectName),
          lanes: [laneLabel],
        },
        locale,
      }).sentence
      setMessage(sentence)
      toast.add({ type: "success", title: sentence })
      onDone?.()
    } catch (err) {
      setPhase("error")
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  const busy = phase === "submitting"

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        // This control is mounted inside the row's actions cell on clickable
        // tables (OverviewLaneTable), and rows navigate on click. This press
        // belongs to the popover, not the row.
        onClick={(event) => event.stopPropagation()}
        render={
          <button
            type="button"
            className={cn(
              anchorOnly
                ? "sr-only"
                : "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-muted",
            )}
            aria-label={t("org.staffLanePopover.staffLaneHeading", { lane: laneLabel })}
          />
        }
      >
        {trigger ?? (
          <>
            <UserPlus className="size-3.5" aria-hidden />
            {t("org.staffLanePopover.staffLaneHeading", { lane: laneLabel })}
          </>
        )}
      </PopoverTrigger>
      <PopoverContent
        data-testid="staff-lane-popover"
        className="w-80 space-y-3 p-3"
        side="bottom"
        // The popup is portalled out of the table, but React still bubbles its
        // events along the React tree — through the row. Rows are often
        // clickable (and navigate away, unmounting this popover), so picking a
        // name, searching, changing the role or confirming must not also count
        // as a row click. Mirrors DataTableRowActionsButton's menu guard.
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <p className="text-xs font-medium">
            {t("org.staffLanePopover.staffLaneHeading", { lane: laneLabel })}
          </p>
          <p className="text-[11px] text-muted-foreground">
            <RichMessage
              k="org.staffLanePopover.addOrgMemberDescription"
              values={{
                member: (
                  <strong className="font-medium text-foreground">
                    {t("org.staffLanePopover.orgMemberPhrase")}
                  </strong>
                ),
              }}
            />
          </p>
        </div>

        {!selected ? (
          <div className="space-y-2">
            {/* AQU-1998 — who is on this lane now, each with Remove. Above the
                search so the lane's current staffing is what the popover
                opens on, with adding someone underneath it. */}
            <StaffedLaneMembers
              projectId={projectId}
              laneLabel={laneLabel}
              // No jwt means no scope read ever fires, so the list is empty
              // rather than loading forever.
              people={jwt ? staffed : []}
              busyUserId={removingUserId}
              error={removeError}
              pending={
                pendingRemoval
                  ? {
                      userId: pendingRemoval.userId,
                      assignmentCount: pendingRemoval.assignments.length,
                    }
                  : null
              }
              onRemove={handleRemove}
              onConfirmRemove={handleConfirmRemove}
              onCancelRemove={() => setPendingRemoval(null)}
              onNavigate={() => handleOpenChange(false)}
            />
            <div className="relative">
              <Search
                className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("org.staffLanePopover.searchPlaceholder")}
                aria-label={t("org.teamDetail.searchOrgMembersAriaLabel")}
                className="h-8 ps-7 text-xs"
                disabled={blockSearch}
              />
            </div>
            {(rosterBlocked === "hidden" || rosterBlocked === "no-access") && !blockSearch && (
              <p
                data-testid="staff-lane-roster-note"
                data-reason={rosterBlocked}
                className="text-[11px] text-muted-foreground"
              >
                {t(ROSTER_BLOCKED_KEY[rosterBlocked])}
              </p>
            )}
            <ul className="max-h-40 divide-y overflow-y-auto rounded border">
              {blockSearch && rosterBlocked !== null ? (
                <li
                  data-testid="staff-lane-roster-blocked"
                  data-reason={rosterBlocked}
                  className="flex items-center justify-center gap-1.5 px-2 py-3 text-center text-[11px] text-muted-foreground"
                >
                  {rosterBlocked === "loading" && <Spinner className="size-3" />}
                  {rosterBlocked === "error"
                    ? (rosterError ?? t("org.staffLanePopover.rosterLoadFailed"))
                    : t(ROSTER_BLOCKED_KEY[rosterBlocked])}
                </li>
              ) : results.length === 0 ? (
                <li className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                  {searchPool.length === 0
                    ? t("org.staffLanePopover.rosterEmpty")
                    : t("org.staffLanePopover.rosterNoMatch")}
                </li>
              ) : (
                results.map((m) => (
                  <li key={m.userId}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-start text-xs hover:bg-muted"
                      onClick={() => setSelected({ userId: m.userId, username: m.username })}
                    >
                      <UsernameWithAvatar userId={m.userId} username={m.username} size="xs" nameClassName="text-xs" />
                    </button>
                  </li>
                ))
              )}
            </ul>
            {/* AQU-607: this control only reaches people already in your org —
                that's why an outside-org name never appears here (the demo's
                "you're not in my organization" dead-end). Surface the second
                path explicitly rather than failing silently: external
                contributors (e.g. translators) join via a project invite
                link, not the org roster. */}
            <p className="text-[11px] text-muted-foreground">
              {t("org.staffLanePopover.searchScopeNote")}{" "}
              <Link
                to={`/project/${projectId}/settings/members`}
                state={{ backgroundLocation: location, projectSettingsModalDepth: 1 }}
                className="font-medium text-foreground underline underline-offset-2"
                onClick={() => handleOpenChange(false)}
              >
                {t("org.staffLanePopover.inviteToProjectLink")}
              </Link>
              .
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <UsernameWithAvatar userId={selected.userId} username={selected.username} size="xs" nameClassName="text-xs" />
              <Button
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => setSelected(null)}
                disabled={busy}
              >
                {t("org.projectOverview.change")}
              </Button>
            </div>

            <RoleSelect
              options={STAFFABLE_ROLES.map((level) => ({
                level,
                name: roleName(level),
                description: roleDescription(level),
              }))}
              value={role}
              onValueChange={setRole}
              disabled={busy}
              size="sm"
              aria-label={t("common.roleLabel")}
            />

            {seesEveryLane ? (
              <p data-testid="staff-lane-sees-every-lane" className="text-[11px] text-muted-foreground">
                {t("org.staffLanePopover.alreadySeesEveryLanguage", { name: selected.username })}
              </p>
            ) : (
              <GrantScopeNotice
                sentence={describeGrant(t, {
                  names: [selected.username],
                  roleLevel: heldRole,
                  stays: keepsRole,
                  scope: {
                    kind: "project",
                    projectName: grantProjectName(t, projectName),
                    lanes: [laneLabel],
                  },
                  locale,
                }).sentence}
              />
            )}
            <Button className="w-full" size="sm" onClick={handleConfirm} disabled={busy || !jwt || seesEveryLane}>
              {busy && <Spinner className="me-1.5 size-3.5" />}
              {grantButtonLabel(
                t,
                t("common.add"),
                describeGrant(t, {
                  names: [selected.username],
                  roleLevel: heldRole,
                  scope: {
                    kind: "project",
                    projectName: grantProjectName(t, projectName),
                    lanes: [laneLabel],
                  },
                  locale,
                }).scopeEcho,
              )}
            </Button>

            {phase === "done" && message && (
              <p data-testid="grant-scope-result" className="text-[11px] text-emerald-600 dark:text-emerald-400">{message}</p>
            )}
            {phase === "error" && errorMsg && (
              <p className="text-[11px] text-destructive">{errorMsg}</p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
