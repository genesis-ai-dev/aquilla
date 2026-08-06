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
import { Link } from "react-router-dom"
import { Search, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { RoleLabel } from "@/components/RoleLabel"
import { ROLE, roleName, roleDisplayText } from "@/lib/frontier/roles"
import { useOrgMembers } from "@/hooks/useOrg"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { addProjectMember } from "@/lib/frontier/members"
import { fetchMemberScopes, putMemberScopes, type MemberScope } from "@/lib/sync/member-scopes"

/** Pinned contract — wave-B agents import this exactly. */
export interface StaffLanePopoverProps {
  projectId: string
  lane: string
  laneLabel: string
  orgId: number | null
  trigger?: ReactNode
  onDone?: () => void
}

/** The staffing role select is intentionally scoped to reviewer/contributor
 * only — lead+ is a separate, always-unscoped action (see file header). */
const STAFFABLE_ROLES: readonly number[] = [ROLE.REVIEWER, ROLE.CONTRIBUTOR]

const MAX_RESULTS = 20

type Phase = "idle" | "submitting" | "done" | "error"

export function StaffLanePopover({
  projectId,
  lane,
  laneLabel,
  orgId,
  trigger,
  onDone,
}: StaffLanePopoverProps) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const { members: orgMembers } = useOrgMembers(orgId)
  const { members: projectMembers, refresh: refreshProjectMembers } = useProjectMembers(projectId)

  const [open, setOpen] = useState(false)
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

  function reset() {
    setQuery("")
    setSelected(null)
    setRole(ROLE.REVIEWER)
    setPhase("idle")
    setMessage(null)
    setErrorMsg(null)
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
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
    return [
      ...existing.filter((s) => !(s.kind === "lane" && s.value === lane)),
      { kind: "lane", value: lane },
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
      setMessage(`${selected.username} is now ${roleDisplayText(roleName(role))} on ${laneLabel}.`)
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
        render={
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-muted"
            aria-label={`Staff ${laneLabel}`}
          />
        }
      >
        {trigger ?? (
          <>
            <UserPlus className="size-3.5" aria-hidden />
            Staff {laneLabel}
          </>
        )}
      </PopoverTrigger>
      <PopoverContent
        data-testid="staff-lane-popover"
        className="w-80 space-y-3 p-3"
        side="bottom"
      >
        <div>
          <p className="text-xs font-medium">Staff {laneLabel}</p>
          <p className="text-[11px] text-muted-foreground">
            Add an <strong className="font-medium text-foreground">org member</strong> to
            this project, scoped to this lane.
          </p>
        </div>

        {!selected ? (
          <div className="space-y-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your organization"
                aria-label="Search org members"
                className="h-8 pl-7 text-xs"
              />
            </div>
            <ul className="max-h-40 divide-y overflow-y-auto rounded border">
              {results.length === 0 ? (
                <li className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                  {orgMembers.length === 0
                    ? "No one in your organization yet."
                    : "No org members match."}
                </li>
              ) : (
                results.map((m) => (
                  <li key={m.userId}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted"
                      onClick={() => setSelected({ userId: m.userId, username: m.username })}
                    >
                      <UsernameWithAvatar username={m.username} size="xs" nameClassName="text-xs" />
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
              Searches your organization only. Adding someone from outside it?{" "}
              <Link
                to={`/project/${projectId}/settings/members`}
                className="font-medium text-foreground underline underline-offset-2"
                onClick={() => setOpen(false)}
              >
                Invite them to the project
              </Link>
              .
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <UsernameWithAvatar username={selected.username} size="xs" nameClassName="text-xs" />
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => setSelected(null)}
                disabled={busy}
              >
                Change
              </Button>
            </div>

            <Select
              items={STAFFABLE_ROLES.map((level) => ({
                value: String(level),
                label: roleDisplayText(roleName(level)),
              }))}
              value={String(role)}
              onValueChange={(v) => setRole(parseInt(v ?? String(ROLE.REVIEWER), 10))}
              disabled={busy}
            >
              <SelectTrigger size="sm" aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {STAFFABLE_ROLES.map((level) => (
                    <SelectItem key={level} value={String(level)}>
                      <RoleLabel name={roleName(level)} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>

            <Button className="w-full" size="sm" onClick={handleConfirm} disabled={busy || !jwt}>
              {busy && <Spinner className="mr-1.5 size-3.5" />}
              Add to {laneLabel}
            </Button>

            <div className="rounded border border-dashed p-2 text-[11px] text-muted-foreground">
              Need broader access? Leads see all languages.{" "}
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2 disabled:opacity-60"
                onClick={handleAddAsLead}
                disabled={busy || !jwt}
              >
                Add as lead (unscoped)
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
