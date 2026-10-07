// AQU-538 §3.4 — one-gesture staffing control. "Add María as reviewer on
// Spanish" in a single confirm: pick a person from the org roster, pick a
// role (reviewer/contributor — leads are a separate, always-unscoped
// affordance), confirm. Confirm then:
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
// Leads/maintainers (effective role >= project_lead) can't be lane-scoped —
// the server rejects PUT scopes for them with 400 ("scopes are for
// contributor/reviewer roles"), since leads see every language by design.
// The role select here only ever offers reviewer/contributor, so that 400
// can only happen when the picked person's EXISTING effective role is
// already lead+ (e.g. an org-wide maintainer) — handled gracefully as a
// non-error "already unscoped" outcome. Adding someone AS a lead is a
// distinct, deliberately unscoped action (no scope PUT at all).

import { useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { Search, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { RoleSelect } from "@/components/RoleSelect"
import { ROLE, roleName, roleDisplayLabel, roleDescription } from "@/lib/frontier/roles"
import { useOrgMembers } from "@/hooks/useOrg"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { addProjectMember } from "@/lib/frontier/members"
import { fetchMemberScopes, putMemberScopes, type MemberScope } from "@/lib/sync/member-scopes"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

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

/** The staffing role select is intentionally scoped to reviewer/contributor
 * only — lead+ is a separate, always-unscoped action (see file header). */
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
  orgId,
  trigger,
  onDone,
  open: openProp,
  onOpenChange,
  anchorOnly = false,
}: StaffLanePopoverProps) {
  const { t } = useI18n()
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

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pool = q ? orgMembers.filter((m) => m.username.toLowerCase().includes(q)) : orgMembers
    return pool.slice(0, MAX_RESULTS)
  }, [orgMembers, query])

  /**
   * Why the roster can't be searched, or null when it can. Ordered most
   * specific first: a missing org id means the fetch never even fired, so it
   * outranks the loading flag (which stays false in that case).
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

  function reset() {
    setQuery("")
    setSelected(null)
    setRole(ROLE.REVIEWER)
    setPhase("idle")
    setMessage(null)
    setErrorMsg(null)
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
    await addProjectMember(jwt, projectId, username, targetRole)
  }

  function mergeLaneScope(existing: MemberScope[]): MemberScope[] {
    // AQU-1607: write the lane id when we have it, and drop a row that named
    // this same lane the old way so the member ends up with one scope for it.
    const value = laneId || lane
    return [
      ...existing.filter((s) => !(s.kind === "lane" && (s.value === value || s.value === lane))),
      { kind: "lane", value },
    ]
  }

  async function handleConfirm() {
    if (!selected || !jwt) return
    setPhase("submitting")
    setErrorMsg(null)
    try {
      await ensureMembership(selected.userId, selected.username, role)
      try {
        const existingScopes = (await fetchMemberScopes(jwt, projectId, selected.userId)) ?? []
        await putMemberScopes(jwt, projectId, selected.userId, mergeLaneScope(existingScopes))
      } catch (scopeErr) {
        const text = scopeErr instanceof Error ? scopeErr.message : String(scopeErr)
        if (text.toLowerCase().includes("contributor/reviewer")) {
          // The person's effective role is already lead+ — the server is
          // correctly refusing to scope them. From the operator's point of
          // view that's not a failure: they already see every language.
          await refreshProjectMembers()
          setPhase("done")
          setMessage(
            `${selected.username} already leads this project and sees every language — no lane scope needed.`,
          )
          onDone?.()
          return
        }
        throw scopeErr
      }
      await refreshProjectMembers()
      setPhase("done")
      setMessage(`${selected.username} is now ${roleDisplayLabel(role)} on ${laneLabel}.`)
      onDone?.()
    } catch (err) {
      setPhase("error")
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  /** "Leads see all languages" — a distinct, always-unscoped add. No scope
   * PUT is issued at all, so the 500+ rejection never applies here. */
  async function handleAddAsLead() {
    if (!selected || !jwt) return
    setPhase("submitting")
    setErrorMsg(null)
    try {
      await ensureMembership(selected.userId, selected.username, ROLE.PROJECT_LEAD)
      await refreshProjectMembers()
      setPhase("done")
      setMessage(`${selected.username} is now a lead — leads see every language, unscoped.`)
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
                disabled={rosterBlocked !== null}
              />
            </div>
            <ul className="max-h-40 divide-y overflow-y-auto rounded border">
              {rosterBlocked !== null ? (
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
                  {orgMembers.length === 0
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

            <Button className="w-full" size="sm" onClick={handleConfirm} disabled={busy || !jwt}>
              {busy && <Spinner className="me-1.5 size-3.5" />}
              {t("org.staffLanePopover.addToLaneButton", { lane: laneLabel })}
            </Button>

            <div className="rounded border border-dashed p-2 text-[11px] text-muted-foreground">
              {t("org.staffLanePopover.broaderAccessNote")}{" "}
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2 disabled:opacity-60"
                onClick={handleAddAsLead}
                disabled={busy || !jwt}
              >
                {t("org.staffLanePopover.addAsLeadButton")}
              </button>
            </div>

            {phase === "done" && message && (
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400">{message}</p>
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
