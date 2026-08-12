// AQU-180: Per-project members page (/project/:id/members).
//
// Renders inside the ProjectWorkspace shell (AQU-254 surface-swap pattern).
// Shell stays mounted; only the center content area swaps.
//
// Features:
//   - Effective member list (GET /projects/:id/members) incl. secondarySources
//   - Direct-grant add / change-role / remove (reuses useProjectMembers hook)
//   - Invite-link generation with expiry selector (reuses InviteLinkTab logic)
//   - "Revoke all access" with grant-path enumeration + typed confirmation

import { useState, useCallback, useEffect, useMemo } from "react"
import { useParams } from "react-router-dom"
import {
  ArrowLeft, UserPlus, LinkIcon, ShieldOff, RefreshCcw,
  AlertTriangle, Copy, Lock, Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { AppTooltip } from "@/components/ui/tooltip"
import { Input } from "@/components/ui/input"
import { FieldLabel } from "@/components/ui/field"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useOpenWorkspace } from "@/hooks/useOpenWorkspace"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { useProjectOrgId } from "@/hooks/useProjectOrgId"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useActiveOrgOptional } from "@/context/OrgContext"
import { listOrgMembers, type OrgMember } from "@/lib/frontier/orgs"
import { PermissionDeniedAlert } from "@/components/PermissionDeniedAlert"
import { MemberMultiAddRow } from "@/components/MemberMultiAddRow"
import {
  revokeAllProjectAccess, partitionMembers, type RevokeAllResult,
} from "@/lib/frontier/members"
import { createServerInvite } from "@/lib/sync/invites"
import {
  ROLE,
  LINK_ROLE_OPTIONS,
  PROJECT_ROLE_OPTIONS,
  resolveRoleName,
} from "@/lib/frontier/roles"
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog"
import { RoleLabel } from "@/components/RoleLabel"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { ProjectMember } from "@/lib/frontier/members"
import { toUserFacingError } from "@/lib/errors/user-error"

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_INVITE_ROLE = ROLE.CONTRIBUTOR
// Labels resolve via t() at render time (InviteLinkTab) rather than being
// hardcoded here, so they stay locale-reactive.
const EXPIRY_OPTIONS: { labelKey: MessageKey; value: number | null }[] = [
  { labelKey: "org.membersPage.expiry1Day", value: 1 },
  { labelKey: "org.membersPage.expiry7DaysDefault", value: 7 },
  { labelKey: "org.membersPage.expiry30Days", value: 30 },
  { labelKey: "org.membersPage.expiryNone", value: null },
]
const DEFAULT_EXPIRY_DAYS = 7

// ──────────────────────────────────────────────────────────────────────────
// Main surface
// ──────────────────────────────────────────────────────────────────────────

type ActiveTab = "members" | "invite"

export function ProjectMembersPage() {
  const { id: projectId } = useParams<{ id: string }>()
  // AQU-737: the workspace route is lazy; surface the load on Back to project so
  // it spins + disables instead of sitting idle and re-clickable.
  // `openingOverlay` blocks the rest of the page while the open is in flight.
  const { open: openWorkspace, isPending: backPending, overlay: openingOverlay } = useOpenWorkspace()
  const [tab, setTab] = useState<ActiveTab>("members")
  const t = useT()

  if (!projectId) return null

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {openingOverlay}
      {/* Back header */}
      <div className="flex items-center gap-3 border-b bg-background px-6 py-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          onClick={() => openWorkspace(`/project/${projectId}/editor`)}
          disabled={backPending}
          aria-busy={backPending || undefined}
        >
          {backPending ? <Spinner className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
          {t("comments.backToProject")}
        </Button>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Users className="h-4 w-4 text-muted-foreground" />
          {t("editor.navTitle.members")}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-2 border-b px-6">
        <button
          type="button"
          onClick={() => setTab("members")}
          className={cn(
            "px-3 py-2 text-sm",
            tab === "members"
              ? "border-b-2 border-primary font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("editor.navTitle.members")}
        </button>
        <button
          type="button"
          onClick={() => setTab("invite")}
          className={cn(
            "px-3 py-2 text-sm",
            tab === "invite"
              ? "border-b-2 border-primary font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("org.membersPage.inviteLinkTab")}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {tab === "members" ? (
          <MembersTab projectId={projectId} />
        ) : (
          <InviteLinkTab projectId={projectId} />
        )}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Members tab
//
// Exported (AQU-335) so the org-side ProjectOverview (/projects/:id) can
// embed the same members add/change-role/revoke surface the in-project
// members page offers — one implementation, two surfaces.
// ──────────────────────────────────────────────────────────────────────────

export function MembersTab({
  projectId,
  className = "mx-auto max-w-2xl space-y-6",
}: {
  projectId: string
  /** Layout wrapper classes; override when embedding outside the members page. */
  className?: string
}) {
  const t = useT()
  const { session } = useFrontierSession()
  const { members, isLoading, error, rosterHidden, refresh, add, addMany, remove } = useProjectMembers(projectId)
  const callerMaxRole = ROLE.MAINTAINER
  const callerUserId = null

  // AQU-672: source the org roster so the add-member field can suggest
  // colleagues instead of forcing an exact-username guess. Prefer the
  // PROJECT's own org (the active-org picker may be on "All organizations"
  // or a different org entirely), falling back to the optional org context —
  // this surface is also embedded on the org-side ProjectOverview and
  // unit-rendered without a provider. A personal (org-less) project yields
  // no suggestions and keeps working as plain free text.
  const projectOrgId = useProjectOrgId(projectId)
  const activeOrgId = useActiveOrgOptional()?.activeOrgId ?? null
  const rosterOrgId = projectOrgId ?? activeOrgId
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([])
  useEffect(() => {
    const jwt = session?.jwt
    if (!jwt || rosterOrgId == null) {
      // Bail without a state change when already empty so we don't force an
      // extra render (keeps this effect side-effect-free on org-less surfaces).
      setOrgMembers((prev) => (prev.length === 0 ? prev : []))
      return
    }
    let alive = true
    listOrgMembers(jwt, rosterOrgId)
      .then((ms) => { if (alive) setOrgMembers(ms) })
      .catch(() => { /* suggestions are best-effort; free text still works */ })
    return () => { alive = false }
  }, [session?.jwt, rosterOrgId])

  // AQU-560: when the add is refused for lack of permission, surface the
  // enriched account-identity + switch-user alert instead of the bare message
  // (the denial is usually "you're on the wrong account").
  const [addForbidden, setAddForbidden] = useState(false)

  // Revoke-all state
  const [revokeTarget, setRevokeTarget] = useState<ProjectMember | null>(null)
  // Remove-direct-grant confirmation (FRO-368: used to remove instantly).
  const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null)

  // AQU-734 parity: grant the whole staged batch in ONE request; per-person
  // failures come back in `results` and are named by the add row itself.
  const handleAddMany = useCallback(async (usernames: string[], role: number) => {
    const results = await addMany(usernames.map((username) => ({ username, role })))
    return results.map((r) => ({
      username: r.username,
      ok: r.ok,
      error: r.error?.message,
    }))
  }, [addMany])

  const grantableRoles = PROJECT_ROLE_OPTIONS.filter((r) => r.level <= callerMaxRole)

  // AQU-454: a project's roster should read as the project's team, not a copy
  // of the whole org. Org members inherit access to every project via AD-12
  // max-wins (04-features/members-and-sharing.md), so a large org floods each
  // project's member list. We still show everyone (spec: "view all members …
  // with a one-line summary of which paths contribute") but split the list so
  // people actually granted access to THIS project (direct / group / creator)
  // are distinct from those who only reach it through an org-wide role.
  const { projectMembers, orgAccessMembers } = partitionMembers(members)

  // AQU-672: eligibility mirrors the Team detail "Add member" combobox —
  // org members minus those who already hold a direct grant on this project.
  // `projectMembers` are exactly the people reached via a project-level path
  // (direct/team/creator); org-access-only members stay eligible so they can
  // be given an explicit project role.
  const directGrantUserIds = useMemo(
    () => new Set(projectMembers.map((m) => m.userId)),
    [projectMembers],
  )
  const eligibleOrgMembers = useMemo(
    () =>
      orgMembers
        .filter((m) => !directGrantUserIds.has(m.userId))
        .sort((a, b) =>
          a.username.localeCompare(b.username, undefined, { sensitivity: "base" }),
        ),
    [orgMembers, directGrantUserIds],
  )

  const renderMemberRow = (m: ProjectMember) => {
    const isSelf = callerUserId !== null && m.userId === callerUserId
    const isLocked = m.role.source === "org" || m.role.source === "creator"
    const lockedHint =
      m.role.source === "org"
        ? t("org.membersPage.lockedHintOrgAccess")
        : m.role.source === "creator"
          ? t("org.membersPage.lockedHintCreator")
          : undefined

    return (
      <li
        key={m.userId}
        className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm"
      >
        <span className="font-medium">{m.username}</span>
        <SourceBadge source={m.role.source} />
        <RoleLabel name={m.role.name} className="text-xs text-muted-foreground" />

        {/* Secondary sources */}
        {m.secondarySources && m.secondarySources.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            + {m.secondarySources.map((s) => `${s.source}:${s.name}`).join(", ")}
          </span>
        )}

        <div className="ms-auto flex items-center gap-2">
          {/* Role change dropdown — only for direct grants, not self */}
          {!isLocked && !isSelf && (
            <Select
              items={[
                // Current role may sit above the caller's grantable
                // cap; include it so the closed trigger renders the
                // role name instead of the raw level.
                ...(grantableRoles.some((r) => r.level === m.role.level)
                  ? []
                  : [{ value: String(m.role.level), label: resolveRoleName(t, m.role.name) }]),
                ...grantableRoles.map((r) => ({
                  value: String(r.level),
                  label: resolveRoleName(t, r.name),
                })),
              ]}
              value={String(m.role.level)}
              onValueChange={(v) => {
                void add(m.username, parseInt(v ?? "", 10))
              }}
            >
              <SelectTrigger size="sm" aria-label={t("org.membersPage.changeRoleAria")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {grantableRoles.map((r) => (
                    <SelectItem key={r.level} value={String(r.level)}>
                      <RoleLabel name={r.name} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}

          {/* Remove button for direct grants */}
          {!isLocked && !isSelf && m.role.source === "override" ? (
            <AppTooltip content={t("org.membersPage.removeDirectAccessTooltip", { username: m.username })}>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setRemoveTarget(m)}
              >
                {t("org.membersPage.remove")}
              </Button>
            </AppTooltip>
          ) : isLocked ? (
            <AppTooltip content={lockedHint}>
              <span className="text-[10px] text-muted-foreground">
                {lockedHint ?? ""}
              </span>
            </AppTooltip>
          ) : null}

          {/* Revoke all — available when session exists + maintainer+ */}
          {session?.jwt && !isSelf && (
            <AppTooltip content={t("org.membersPage.revokeAllTooltip")}>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1 text-destructive/70 hover:text-destructive"
                onClick={() => setRevokeTarget(m)}
              >
                <ShieldOff className="h-3.5 w-3.5" />
                {t("org.membersPage.revokeAll")}
              </Button>
            </AppTooltip>
          )}
        </div>
      </li>
    )
  }

  // AQU-485: the project's org rosterViewMinRole policy hides the roster
  // from this caller. Render a distinct "hidden" state — no member list, no
  // count, and no add-member form (which would itself imply an editable
  // roster exists) — never an empty shell that leaks "zero members."
  if (rosterHidden) {
    return (
      <div className={className}>
        <div className="flex flex-col items-center gap-2 rounded border py-10 text-center text-muted-foreground">
          <Lock className="h-5 w-5" />
          <p className="text-sm font-medium text-foreground">{t("org.membersPage.rosterHiddenTitle")}</p>
          <p className="max-w-xs text-xs">
            {t("org.membersPage.rosterHiddenBody")}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={className}>
      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button
            type="button"
            className="ms-auto text-xs underline"
            onClick={() => void refresh()}
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* Members list */}
      <div>
        {/* AQU-488: explicit scope label. A first-time PM opening this
            section cold must be able to tell at a glance whether it's
            listing this project's people or the whole org — this list is
            always project-scoped (the effective roster for THIS project,
            per-row labeled with how each person got access below). */}
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">
            {orgAccessMembers.length > 0
              ? t("editor.navTitle.projectMembers")
              : t("org.membersPage.currentMembersHeading")}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-muted-foreground"
            onClick={() => void refresh()}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            {t("common.refresh")}
          </Button>
        </div>
        {members.length > 0 && (
          <p className="mb-2 text-xs text-muted-foreground">
            {t("org.membersPage.rosterHint")}
          </p>
        )}

        {isLoading && members.length === 0 ? (
          <LoadingPanel label={t("org.membersPage.loadingMembers")} className="min-h-48" />
        ) : members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("org.membersPage.noMembersYet")}</p>
        ) : (
          <>
            {projectMembers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("org.membersPage.noDirectMembers")}
              </p>
            ) : (
              <ul className="divide-y rounded border">
                {projectMembers.map(renderMemberRow)}
              </ul>
            )}

            {/* AQU-454: org-wide members reach this project via their org role,
                not a project grant. Kept visible (per spec) but sectioned so the
                roster above reads as the actual project team. */}
            {orgAccessMembers.length > 0 && (
              <div className="mt-5" data-testid="org-access-members">
                <h3 className="mb-1 text-sm font-medium">
                  {t("org.membersPage.orgAccessHeading")}
                </h3>
                <p className="mb-2 text-xs text-muted-foreground">
                  {t("org.membersPage.orgAccessSummary", { count: orgAccessMembers.length })}
                </p>
                <ul className="divide-y rounded border">
                  {orgAccessMembers.map(renderMemberRow)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {/* Add member — AQU-734 parity: multi-select staging + one batch Add.
          Eligible org colleagues show as checkbox rows on focus (AQU-672). */}
      <div className="rounded border p-4 space-y-3">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-muted-foreground" />
          {t("org.membersPage.addMemberHeading")}
        </h2>
        <MemberMultiAddRow
          roleOptions={grantableRoles}
          defaultRole={ROLE.CONTRIBUTOR}
          onAdd={handleAddMany}
          excludedUserIds={[...directGrantUserIds]}
          suggestions={
            orgMembers.length > 0
              ? eligibleOrgMembers.map((m) => ({ id: m.userId, username: m.username }))
              : undefined
          }
          emptySuggestionsHint={t("org.membersPage.allOrgMembersAdded")}
          onAddStart={() => setAddForbidden(false)}
          onBatchErrorMessage={(e) => {
            const uf = toUserFacingError(e, "project")
            if (uf.category === "forbidden") {
              setAddForbidden(true)
              return null
            }
            return uf.message
          }}
          buttonSize="sm"
        />
        {addForbidden && (
          <PermissionDeniedAlert
            action={t("org.membersPage.addMembersAction")}
            requiredRole={t("org.membersPage.requiredRoleMaintainerOrHigher")}
          />
        )}
      </div>

      {/* Remove-direct-grant confirmation (FRO-368) */}
      <ConfirmActionDialog
        open={removeTarget !== null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}
        title={t("org.membersPage.removeMemberTitle")}
        description={
          removeTarget
            ? t("org.membersPage.removeMemberDescription", {
                username: removeTarget.username,
                role: resolveRoleName(t, removeTarget.role.level),
              })
            : ""
        }
        confirmLabel={t("org.membersPage.remove")}
        variant="destructive"
        onConfirm={() => {
          if (removeTarget) void remove(removeTarget.userId)
          setRemoveTarget(null)
        }}
      />

      {/* Revoke-all dialog */}
      {revokeTarget && (
        <RevokeAllDialog
          member={revokeTarget}
          projectId={projectId}
          onClose={() => setRevokeTarget(null)}
          onRevoked={() => {
            setRevokeTarget(null)
            void refresh()
          }}
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Revoke-all confirmation dialog
// ──────────────────────────────────────────────────────────────────────────

interface RevokeAllDialogProps {
  member: ProjectMember
  projectId: string
  onClose: () => void
  onRevoked: () => void
}

function RevokeAllDialog({
  member, projectId, onClose, onRevoked,
}: RevokeAllDialogProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const [confirmation, setConfirmation] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RevokeAllResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The user must type the member's username to confirm.
  const confirmationRequired = member.username
  const confirmed = confirmation.trim() === confirmationRequired

  async function handleRevoke() {
    if (!session?.jwt || !confirmed) return
    setBusy(true)
    setError(null)
    try {
      const r = await revokeAllProjectAccess(session.jwt, projectId, member.userId)
      setResult(r)
    } catch (e) {
      setError(toUserFacingError(e, "project").message)
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    // Show summary of what happened
    const remainingNonRemovable = result.grantPaths.filter((p) => !p.removable)
    return (
      <Dialog open onOpenChange={(v) => { if (!v) onRevoked() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("org.membersPage.accessRevokedTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {result.removed ? (
              <p>
                <RichMessage
                  k="org.membersPage.directGrantRemoved"
                  values={{ username: <strong>{member.username}</strong> }}
                />
              </p>
            ) : (
              <p>
                <RichMessage
                  k="org.membersPage.noDirectGrantToRemove"
                  values={{ username: <strong>{member.username}</strong> }}
                />
              </p>
            )}
            {remainingNonRemovable.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                <p className="mb-2 font-medium text-amber-800 dark:text-amber-300">
                  {t("org.membersPage.accessStillGrantedVia")}
                </p>
                <ul className="space-y-1">
                  {remainingNonRemovable.map((p, i) => (
                    <li key={i} className="text-xs text-amber-700 dark:text-amber-400">
                      <span className="font-medium capitalize">{p.source}</span>
                      {" "}({p.name})
                      {p.hint ? ` — ${p.hint}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={onRevoked}>{t("org.membersPage.done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldOff className="h-5 w-5" />
            {t("org.membersPage.revokeAllAccessTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <p>
            <RichMessage
              k="org.membersPage.revokeAllExplanation"
              values={{ username: <strong>{member.username}</strong> }}
            />
          </p>

          {/* Show known grant paths */}
          <div className="rounded border p-3 space-y-1">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              {t("org.membersPage.currentGrantPathsFor", { username: member.username })}
            </p>
            <GrantPathRow
              source={member.role.source}
              level={member.role.level}
              removable={member.role.source === "override"}
            />
            {member.secondarySources?.map((s, i) => (
              <GrantPathRow
                key={i}
                source={s.source}
                level={s.level}
                removable={false}
              />
            ))}
          </div>

          <div className="space-y-1">
            <FieldLabel htmlFor="revoke-confirm" className="text-xs">
              <RichMessage
                k="org.membersPage.typeToConfirm"
                values={{ username: <strong>{confirmationRequired}</strong> }}
              />
            </FieldLabel>
            <Input
              id="revoke-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={confirmationRequired}
              autoComplete="off"
            />
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={!confirmed || busy}
            onClick={() => void handleRevoke()}
          >
            {busy ? t("org.membersPage.revoking") : t("org.membersPage.revokeAccess")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Invite-link tab (reuses SharePanel's InviteLinkTab logic)
// ──────────────────────────────────────────────────────────────────────────

function InviteLinkTab({ projectId }: { projectId: string }) {
  const t = useT()
  const { session } = useFrontierSession()
  const [inviteRole, setInviteRole] = useState<number>(DEFAULT_INVITE_ROLE)
  const [inviteEmail, setInviteEmail] = useState<string>("")
  const [emailError, setEmailError] = useState<string | null>(null)
  const [expiresInDays, setExpiresInDays] = useState<number | null>(DEFAULT_EXPIRY_DAYS)
  const [busy, setBusy] = useState(false)
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  async function handleCreate() {
    setEmailError(null)
    setServerError(null)
    setIssuedUrl(null)
    const trimmedEmail = inviteEmail.trim()
    if (trimmedEmail.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setEmailError(t("org.membersPage.invalidEmailError"))
      return
    }
    if (!session?.jwt) {
      setServerError(t("org.membersPage.signInRequiredError"))
      return
    }
    setBusy(true)
    try {
      const serverInvite = await createServerInvite(
        session.jwt,
        projectId,
        inviteRole,
        undefined,
        trimmedEmail || undefined,
        expiresInDays,
      )
      if (!serverInvite) {
        setServerError(t("org.membersPage.createInviteFailedError"))
        return
      }
      const url = `${window.location.origin}/join/${serverInvite.token}`
      setIssuedUrl(url)
    } finally {
      setBusy(false)
    }
  }

  function copyUrl(url: string) {
    void navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function reset() {
    setIssuedUrl(null)
    setCopied(false)
    setInviteEmail("")
    setInviteRole(DEFAULT_INVITE_ROLE)
    setExpiresInDays(DEFAULT_EXPIRY_DAYS)
  }

  if (issuedUrl) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <LinkIcon className="h-4 w-4 text-muted-foreground" />
          {t("org.membersPage.inviteLinkReadyHeading")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("org.membersPage.inviteLinkReadyBody")}
        </p>
        <div className="flex items-center gap-1">
          <Input value={issuedUrl} readOnly className="text-xs font-mono" />
          <AppTooltip content={t("org.membersPage.copyUrl")}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => copyUrl(issuedUrl)}
              aria-label={t("org.membersPage.copyUrl")}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </AppTooltip>
        </div>
        {copied && <p className="text-xs text-green-600">{t("nav.report.copied")}</p>}
        <p className="text-[10px] text-muted-foreground">
          {t("org.membersPage.inviteRecipientNote", {
            role: (() => {
              const opt = LINK_ROLE_OPTIONS.find((o) => o.level === inviteRole)
              return opt ? resolveRoleName(t, opt.name) : t("org.membersPage.memberFallback")
            })(),
          })}
        </p>
        <Button size="sm" variant="outline" onClick={reset} className="w-full">
          {t("org.membersPage.createAnotherLink")}
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h2 className="text-sm font-medium flex items-center gap-2">
        <LinkIcon className="h-4 w-4 text-muted-foreground" />
        {t("org.membersPage.createInviteLink")}
      </h2>

      <div className="rounded border p-4 space-y-4">
        {/* Role */}
        <div className="space-y-1">
          <FieldLabel className="text-xs">{t("org.membersPage.roleLabel")}</FieldLabel>
          <Select
            items={LINK_ROLE_OPTIONS.map((opt) => ({
              value: String(opt.level),
              label: resolveRoleName(t, opt.name),
            }))}
            value={String(inviteRole)}
            onValueChange={(v) => setInviteRole(Number(v ?? ""))}
            disabled={!session?.jwt}
          >
            <SelectTrigger className="w-full" aria-label={t("org.membersPage.roleLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LINK_ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.level} value={String(opt.level)}>
                    <RoleLabel name={opt.name} />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            {session?.jwt
              ? (() => {
                  const opt = LINK_ROLE_OPTIONS.find((o) => o.level === inviteRole)
                  return opt ? t(opt.descriptionKey) : ""
                })()
              : t("org.membersPage.signInToCreateLinkHint")}
          </p>
        </div>

        {/* Optional email */}
        <div className="space-y-1">
          <FieldLabel htmlFor="pm-invite-email" className="text-xs">
            {t("org.membersPage.recipientEmailLabel")}
          </FieldLabel>
          <Input
            id="pm-invite-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={inviteEmail}
            onChange={(e) => {
              setInviteEmail(e.target.value)
              setEmailError(null)
            }}
            placeholder="name@example.com"
            disabled={!session?.jwt}
          />
          {emailError ? (
            <p className="text-[10px] text-destructive">{emailError}</p>
          ) : (
            <p className="text-[10px] text-muted-foreground">
              {inviteEmail.trim()
                ? t("org.membersPage.emailPrefillHint")
                : t("org.membersPage.openLinkHint")}
            </p>
          )}
        </div>

        {/* Expiry */}
        <div className="space-y-1">
          <FieldLabel className="text-xs">{t("org.membersPage.linkExpiresLabel")}</FieldLabel>
          <Select
            items={EXPIRY_OPTIONS.map((opt) => ({
              value: String(opt.value),
              label: t(opt.labelKey),
            }))}
            value={expiresInDays === null ? "null" : String(expiresInDays)}
            onValueChange={(v) =>
              setExpiresInDays(
                v === "null" || v === null ? null : Number(v),
              )
            }
            disabled={!session?.jwt}
          >
            <SelectTrigger className="w-full" aria-label={t("org.membersPage.linkExpiresLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {EXPIRY_OPTIONS.map((opt) => (
                  <SelectItem key={String(opt.value)} value={String(opt.value)}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {serverError && (
          <p className="text-xs text-destructive">{serverError}</p>
        )}

        <Button
          size="sm"
          onClick={() => void handleCreate()}
          disabled={busy || !session?.jwt}
          className="w-full"
        >
          {busy ? t("org.createDialog.submitCreating") : t("org.membersPage.createInviteLink")}
        </Button>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

// AQU-488: human-readable access-path labels. auth-worker's resolveProjectRole
// (AD-12) returns one of these four `source` values per member — see
// ProjectMemberRole in src/lib/frontier/members.ts. Labeling every row (not
// just org-sourced ones) is what makes project-specific vs. org-wide
// membership visually distinct, per the AQU-488 acceptance criteria.
const SOURCE_LABEL_KEYS: Record<string, MessageKey> = {
  override: "org.membersPage.sourceDirectInvite",
  group: "org.membersPage.sourceViaTeam",
  org: "org.membersPage.sourceViaOrg",
  creator: "org.membersPage.sourceProjectCreator",
}

function SourceBadge({ source }: { source: string }) {
  const t = useT()
  const key = SOURCE_LABEL_KEYS[source]
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {key ? t(key) : source}
    </span>
  )
}

function GrantPathRow({
  source, level, removable,
}: {
  source: string
  level: number
  removable: boolean
}) {
  const t = useT()
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={cn("font-medium capitalize", removable ? "text-foreground" : "text-muted-foreground")}>
        {source}
      </span>
      {/* Role LABEL only — numeric levels are internal (FRO-368). */}
      <span className="text-muted-foreground">→ {resolveRoleName(t, level)}</span>
      {removable ? (
        <span className="text-xs text-destructive/70">{t("org.membersPage.willBeRemoved")}</span>
      ) : (
        <span className="text-xs text-amber-600 dark:text-amber-400">{t("org.membersPage.staysGranted")}</span>
      )}
    </div>
  )
}
