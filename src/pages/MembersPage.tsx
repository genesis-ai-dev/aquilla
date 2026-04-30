import { useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, Grid3x3, List, Loader2, Users, UsersRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useOrg, useOrgMembers } from "@/hooks/useOrg"
import { useAccessibleProjects } from "@/hooks/useAccessibleProjects"
import { MembersPanel, type MembersPanelMember } from "@/components/MembersPanel"
import { MultiProjectInviteDialog } from "@/components/MultiProjectInviteDialog"
import { MembersMatrixView } from "@/components/MembersMatrixView"
import { RemoveOrgMemberDialog } from "@/components/RemoveOrgMemberDialog"
import { ROLE, ORG_ROLE_PICKER, roleName } from "@/lib/frontier/roles"
import type { OrgMemberProject } from "@/lib/frontier/orgs"

type View = "roster" | "matrix"

const ORG_ROLE_DESCRIPTIONS: Record<number, string> = {
  [ROLE.VIEWER]: "Read-only across all projects",
  [ROLE.CONTRIBUTOR]: "Edit content across all projects",
  [ROLE.PROJECT_LEAD]: "Manage members on every project",
  [ROLE.MAINTAINER]: "Lead + manage roles",
}

const ORG_ROLE_OPTIONS = ORG_ROLE_PICKER.map((level) => ({
  level,
  name: roleName(level),
  description: ORG_ROLE_DESCRIPTIONS[level] ?? "",
}))

/**
 * Operational PM home. The previous /settings/org page collapsed three
 * states into "Loading…" — pre-session, fetching, and silent error all
 * looked the same to the user. This page renders each state distinctly,
 * and adds the multi-project invite + per-member project chips that the
 * design loop concluded operational PMs need.
 */
export function MembersPage() {
  const { state, refresh: refreshOrg } = useOrg()

  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <PageShell>
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          <span className="text-sm">
            {state.kind === "idle" ? "Waiting for session…" : "Loading members…"}
          </span>
        </div>
      </PageShell>
    )
  }

  if (state.kind === "error") {
    return (
      <PageShell>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">Couldn't load your organization</p>
          <p className="mt-1 text-xs text-muted-foreground">{state.error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void refreshOrg()}
          >
            Retry
          </Button>
        </div>
      </PageShell>
    )
  }

  return <MembersPageContent orgId={state.org.id} orgName={state.org.name ?? "Organization"} />
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center gap-2">
        <Users className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h1 className="text-xl font-semibold">Members</h1>
      </div>
      {children}
    </div>
  )
}

interface MembersPageContentProps {
  orgId: number
  orgName: string
}

function MembersPageContent({ orgId, orgName }: MembersPageContentProps) {
  const callerUserId = null // FrontierSession has no userId; server enforces self-block.
  const { members, isLoading: membersLoading, error: membersError, add, remove, listMemberProjects, refresh } =
    useOrgMembers(orgId)
  const { projects: accessibleProjects, refresh: refreshProjects } = useAccessibleProjects()
  const [removeTarget, setRemoveTarget] = useState<{ userId: number; username: string } | null>(null)
  const [multiInviteOpen, setMultiInviteOpen] = useState(false)
  const [view, setView] = useState<View>("roster")

  const panelMembers: MembersPanelMember[] = members.map((m) => ({
    userId: m.userId,
    username: m.username,
    roleLevel: m.role.level,
    roleName: m.role.name,
    source: m.role.level === ROLE.OWNER ? "owner-of-org" : "override",
    isLocked: m.role.level === ROLE.OWNER,
    lockedHint: m.role.level === ROLE.OWNER ? "Org owner" : undefined,
  }))

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-1 flex items-center gap-2">
        <Users className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h1 className="text-xl font-semibold">Members</h1>
      </div>
      <p className="mb-5 text-sm text-muted-foreground">
        People in <strong>{orgName}</strong>. Org-level roles apply across every
        project; per-project access can be granted separately via the
        Invite-to-projects flow.
      </p>

      {/* Operational shortcuts */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={() => setMultiInviteOpen(true)}
          disabled={accessibleProjects.length === 0}
        >
          <UsersRound className="mr-1.5 h-4 w-4" />
          Invite to projects…
        </Button>
        <span className="text-[11px] text-muted-foreground">
          Add someone to specific projects without granting org-wide access.
        </span>
      </div>

      {/* View toggle: Roster (per-member detail + add/remove) vs Matrix
          (members × projects scan view for coverage and concentration risk). */}
      <div className="mb-3 inline-flex rounded-md border bg-muted/20 p-0.5">
        <button
          type="button"
          onClick={() => setView("roster")}
          className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs ${
            view === "roster"
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <List className="h-3.5 w-3.5" />
          Roster
        </button>
        <button
          type="button"
          onClick={() => setView("matrix")}
          className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs ${
            view === "matrix"
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Grid3x3 className="h-3.5 w-3.5" />
          Matrix
        </button>
      </div>

      {membersError && (
        <p className="mb-2 text-xs text-destructive">{membersError}</p>
      )}

      {view === "roster" ? (
        membersLoading && members.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <span className="text-sm">Loading members…</span>
          </div>
        ) : (
          <RosterWithProjectChips
            orgId={orgId}
            panelMembers={panelMembers}
            listMemberProjects={listMemberProjects}
            add={add}
            remove={remove}
            callerUserId={callerUserId}
            onRequestRemove={(userId, username) =>
              setRemoveTarget({ userId, username })
            }
          />
        )
      ) : (
        <MembersMatrixView />
      )}

      {removeTarget && (
        <RemoveOrgMemberDialog
          orgId={orgId}
          orgName={orgName}
          userId={removeTarget.userId}
          username={removeTarget.username}
          listProjects={() => listMemberProjects(removeTarget.userId)}
          onClose={() => setRemoveTarget(null)}
          onConfirmed={async () => {
            await remove(removeTarget.userId)
            await refresh()
            setRemoveTarget(null)
          }}
        />
      )}

      <MultiProjectInviteDialog
        open={multiInviteOpen}
        onOpenChange={setMultiInviteOpen}
        projects={accessibleProjects}
        onSuccess={() => {
          // Roster doesn't change (org membership unchanged), but refresh
          // accessible-projects list so future opens reflect any org_id
          // changes that might have happened.
          void refreshProjects()
        }}
      />
    </div>
  )
}

/**
 * Roster + per-row inline expand for project memberships. Keeps the existing
 * MembersPanel for add/remove/role-change, and adds a row affordance to
 * see "where on the project portfolio is this person" without leaving the
 * page. Lazy-fetched: the list_member_projects round-trip only fires when
 * the row is expanded.
 */
interface RosterProps {
  orgId: number
  panelMembers: MembersPanelMember[]
  listMemberProjects: (userId: number) => Promise<OrgMemberProject[]>
  add: (username: string, role: number) => Promise<unknown>
  remove: (userId: number) => Promise<void>
  callerUserId: number | null
  onRequestRemove: (userId: number, username: string) => void
}

function RosterWithProjectChips({
  panelMembers,
  listMemberProjects,
  add,
  callerUserId,
  onRequestRemove,
}: RosterProps) {
  return (
    <div className="space-y-3">
      <MembersPanel
        members={panelMembers}
        roleOptions={ORG_ROLE_OPTIONS}
        defaultRole={ROLE.MAINTAINER}
        callerUserId={callerUserId}
        callerMaxRole={ROLE.MAINTAINER}
        onAdd={async (username, role) => {
          const result = await add(username, role)
          return result
            ? { ok: true }
            : { ok: false, error: "Could not add user. Username may not exist." }
        }}
        onRemove={(userId) => {
          const target = panelMembers.find((m) => m.userId === userId)
          if (target) onRequestRemove(target.userId, target.username)
          return Promise.resolve()
        }}
        onChangeRole={async (username, role) => {
          await add(username, role)
        }}
      />

      <div className="rounded border bg-muted/20 p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Per-member project access
        </p>
        <ul className="divide-y">
          {panelMembers.map((m) => (
            <ProjectChipsRow
              key={m.userId}
              userId={m.userId}
              username={m.username}
              loadProjects={() => listMemberProjects(m.userId)}
            />
          ))}
        </ul>
      </div>
    </div>
  )
}

interface ProjectChipsRowProps {
  userId: number
  username: string
  loadProjects: () => Promise<OrgMemberProject[]>
}

function ProjectChipsRow({ username, loadProjects }: ProjectChipsRowProps) {
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<OrgMemberProject[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchOnce = useCallback(async () => {
    if (projects !== null || loading) return
    setLoading(true)
    setError(null)
    try {
      const next = await loadProjects()
      setProjects(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [loadProjects, projects, loading])

  useEffect(() => {
    if (open) void fetchOnce()
  }, [open, fetchOnce])

  return (
    <li className="py-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-muted"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium">{username}</span>
        {projects && (
          <span className="text-[10px] text-muted-foreground">
            {projects.length > 0
              ? `${projects.length} direct project membership${projects.length === 1 ? "" : "s"}`
              : "no direct project memberships"}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-4 mt-1 flex flex-wrap gap-1">
          {loading && (
            <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </span>
          )}
          {error && <span className="text-[10px] text-destructive">{error}</span>}
          {!loading && !error && projects && projects.length === 0 && (
            <span className="text-[10px] text-muted-foreground">
              Inherits org-level role on every project; no direct overrides.
            </span>
          )}
          {projects?.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[10px]"
              title={`${p.name} • ${p.role.name}`}
            >
              <span className="max-w-[12rem] truncate">{p.name}</span>
              <span className="text-muted-foreground">·</span>
              <span className="capitalize text-muted-foreground">
                {p.role.name.replace(/_/g, " ")}
              </span>
            </span>
          ))}
        </div>
      )}
    </li>
  )
}

