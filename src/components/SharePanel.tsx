import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Copy, AlertCircle, Trash2 } from "lucide-react"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { fmtShortCalendarDate } from "@/lib/format-date"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { FieldLabel, OptionalMark } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  createServerInvite,
  listProjectInvites,
  revokeProjectInvite,
  type ActiveProjectInvite,
} from "@/lib/sync/invites"
import { fetchProjectSettings } from "@/lib/sync/project-settings"
import { resolveCloudProjectResult } from "@/lib/sync/cloud-projects"
import { fetchMemberScopes, putMemberScopes } from "@/lib/sync/member-scopes"
import posthog from "@/lib/posthog"
import { INVITE_SENT } from "@/lib/event-names"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { useProjectOrgId } from "@/hooks/useProjectOrgId"
import { listOrgMembers, type OrgMember } from "@/lib/frontier/orgs"
import { partitionMembers } from "@/lib/frontier/members"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import { toUserFacingError } from "@/lib/errors/user-error"
import {
  MembersPanel,
  type MembersPanelMember,
  type MembersPanelScopeConfig,
  type MemberScopeValue,
} from "./MembersPanel"
import {
  ROLE,
  LINK_ROLE_OPTIONS,
  PROJECT_ROLE_OPTIONS,
  roleDisplayLabel,
} from "@/lib/frontier/roles"
import { RoleLabel } from "@/components/RoleLabel"
import { RoleSelect } from "@/components/RoleSelect"
import type { MessageKey } from "@/lib/i18n/messages/en"

interface SharePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  /** Fires after a server invite is successfully minted so the parent can
   * refresh any "you have outstanding shares" UI (onboarding checklist). */
  onSharesChanged?: () => void
}

// Roles visible in the share-link UI come from LINK_ROLE_OPTIONS (capped at
// contributor by ../lib/frontier/roles). Roles in the per-project Members tab
// come from PROJECT_ROLE_OPTIONS. Both are mirrored server-side; the
// server is the security boundary, this picker is the UX hint.
const DEFAULT_INVITE_ROLE = ROLE.CONTRIBUTOR

type Tab = "members" | "link"

export function SharePanel({ open, onOpenChange, projectId, onSharesChanged }: SharePanelProps) {
  const t = useT()
  const [tab, setTab] = useState<Tab>("members")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("projectSettings.share.dialogTitle")}</DialogTitle>
        </DialogHeader>

        <div className="mb-3 flex gap-2 border-b">
          <button
            type="button"
            onClick={() => setTab("members")}
            className={`px-3 py-1.5 text-sm ${
              tab === "members"
                ? "border-b-2 border-foreground font-medium"
                : "text-muted-foreground"
            }`}
          >
            {t("projectSettings.share.tabMembers")}
          </button>
          <button
            type="button"
            onClick={() => setTab("link")}
            className={`px-3 py-1.5 text-sm ${
              tab === "link"
                ? "border-b-2 border-foreground font-medium"
                : "text-muted-foreground"
            }`}
          >
            {t("projectSettings.share.tabInviteLink")}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pb-1.5">
          {tab === "members" ? (
            <MembersTab projectId={projectId} />
          ) : (
            <InviteLinkTab
              projectId={projectId}
              onSharesChanged={onSharesChanged}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MembersTab({ projectId }: { projectId: string }) {
  const t = useT()
  // FrontierSession has no userId — server enforces self-grant rejection so we
  // pass null and skip the local self-block.
  const callerUserId = null
  const { session } = useFrontierSession()
  const callerUsername = session?.username ?? null
  const jwt = session?.jwt ?? null

  const { members, isLoading, error, add, addMany, remove } = useProjectMembers(projectId)

  // AQU-672 parity for the Share modal: offer org colleagues as checkbox rows
  // before any search fires. Eligibility mirrors the members page — org
  // members minus those who already hold a project-level grant
  // (direct/team/creator); org-access-only members stay eligible so they can
  // be given an explicit project role. The roster comes from the PROJECT's
  // own org (the active-org picker may be on "All organizations"). Personal
  // projects and failed lookups intentionally degrade to search + free text;
  // falling back to the selected org can expose the wrong colleague roster.
  const { orgId: projectOrgId, error: projectOrgError } = useProjectOrgId(projectId)
  const rosterOrgId = projectOrgError ? null : projectOrgId
  const [orgMembers, setOrgMembers] = useState<OrgMember[] | null>(null)
  const [loadedRosterKey, setLoadedRosterKey] = useState<string | null>(null)
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null)
  const rosterKey = callerUsername && rosterOrgId != null
    ? `${callerUsername}\u0000${rosterOrgId}`
    : null
  const visibleOrgMembers = loadedRosterKey === rosterKey ? orgMembers : null
  useEffect(() => {
    if (!jwt || rosterOrgId == null) {
      setOrgMembers(null)
      setLoadedRosterKey(null)
      return
    }
    let alive = true
    setOrgMembers(null)
    setLoadedRosterKey(null)
    setSuggestionsError(null)
    listOrgMembers(jwt, rosterOrgId)
      .then((ms) => {
        if (alive) {
          setOrgMembers(ms)
          setLoadedRosterKey(rosterKey)
        }
      })
      .catch((caught) => {
        if (alive) {
          setOrgMembers(null)
          setLoadedRosterKey(null)
          setSuggestionsError(toUserFacingError(caught, "organization members").message)
        }
      })
    return () => { alive = false }
  }, [jwt, rosterKey, rosterOrgId])

  const projectGrantUserIds = useMemo(
    () => new Set(partitionMembers(members).projectMembers.map((m) => m.userId)),
    [members],
  )
  const suggestions = useMemo(
    () =>
      visibleOrgMembers == null
        ? undefined
        : visibleOrgMembers
            .filter((m) => !projectGrantUserIds.has(m.userId))
            .map((m) => ({ id: m.userId, username: m.username })),
    [visibleOrgMembers, projectGrantUserIds],
  )

  // AQU-285 (F-A4): derive callerMaxRole from the caller's own effective role
  // in the members list so the role picker never offers what the server 403s.
  // Fall back to MAINTAINER (600) if the caller's entry isn't in the list yet
  // (e.g. still loading) — the server is the security boundary regardless.
  const callerMember = callerUsername
    ? members.find((m) => m.username === callerUsername)
    : undefined
  const callerMaxRole = callerMember?.role.level ?? ROLE.MAINTAINER

  const panelMembers: MembersPanelMember[] = members.map((m) => ({
    userId: m.userId,
    username: m.username,
    roleLevel: m.role.level,
    roleName: m.role.name,
    source: m.role.source,
    isLocked: m.role.source === "org" || m.role.source === "creator",
    lockedHint:
      m.role.source === "org"
        ? t("projectSettings.share.lockedHintOrg")
        : m.role.source === "creator"
          ? t("projectSettings.share.lockedHintCreator")
          : undefined,
  }))

  // AQU-553: only leads+ can manage member scopes, and leads are themselves
  // never scopable — so the fetches below are skipped entirely for anyone
  // who wouldn't see the editor MembersPanel renders.
  const canManageScopes = callerMaxRole >= ROLE.PROJECT_LEAD

  const [scopeLanes, setScopeLanes] = useState<Array<{ value: string; label: string }>>([
    { value: "", label: "Default" },
  ])
  const [scopeFiles, setScopeFiles] = useState<Array<{ id: string; name: string }>>([])
  const [scopesByUser, setScopesByUser] = useState<Record<number, MemberScopeValue[]>>({})
  const [scopeOptionsError, setScopeOptionsError] = useState<string | null>(null)
  const [memberScopesError, setMemberScopesError] = useState<string | null>(null)
  const [scopeOptionsReady, setScopeOptionsReady] = useState(false)
  const [memberScopesReady, setMemberScopesReady] = useState(false)
  const [loadedScopeOptionsKey, setLoadedScopeOptionsKey] = useState<string | null>(null)
  const [loadedMemberScopesKey, setLoadedMemberScopesKey] = useState<string | null>(null)
  const scopeLoadRequestRef = useRef(0)
  const currentScopeKey = callerUsername ? `${callerUsername}\u0000${projectId}` : null

  // Lanes + files come from the project's settings/record — fetched once per
  // (project, caller) as soon as the caller can manage scopes. Failure to
  // load settings just leaves the "Default" lane placeholder in place.
  useEffect(() => {
    setScopeOptionsReady(false)
    setLoadedScopeOptionsKey(null)
    setScopeOptionsError(null)
    setScopeLanes([{ value: "", label: "Default" }])
    setScopeFiles([])
    if (!canManageScopes || !jwt) return
    let alive = true
    void (async () => {
      try {
        const [settingsRes, projectRes] = await Promise.all([
          fetchProjectSettings(jwt, projectId),
          resolveCloudProjectResult(projectId, jwt),
        ])
        if (!alive) return
        const defaultLabel = settingsRes?.settings.targetLanguage || "Default"
        setScopeLanes([
          { value: "", label: defaultLabel },
          ...(settingsRes?.settings.targetLanes ?? []).map((t) => ({ value: t, label: t })),
        ])
        if (!projectRes.ok) {
          if (projectRes.reason === "unauthenticated") void notifySessionExpiredIfCurrent(jwt)
          throw new Error("Could not load project scope details.")
        }
        setScopeFiles(
          (projectRes.project.files ?? []).map((f) => ({ id: f.id, name: f.name })),
        )
        setScopeOptionsReady(true)
        setLoadedScopeOptionsKey(currentScopeKey)
      } catch (caught) {
        if (alive) {
          setScopeLanes([{ value: "", label: "Default" }])
          setScopeFiles([])
          setScopeOptionsReady(false)
          setLoadedScopeOptionsKey(null)
          setScopeOptionsError(toUserFacingError(caught, "project scopes").message)
        }
      }
    })()
    return () => { alive = false }
  }, [canManageScopes, currentScopeKey, jwt, projectId])

  // Members below project_lead are the only scopable rows (leads+ must stay
  // unscoped). Recomputed whenever the roster changes.
  const scopableUserIds = useMemo(
    () => members.filter((m) => m.role.level < ROLE.PROJECT_LEAD).map((m) => m.userId),
    [members],
  )

  const loadScopes = useCallback(async () => {
    const requestId = ++scopeLoadRequestRef.current
    setMemberScopesReady(false)
    setLoadedMemberScopesKey(null)
    setMemberScopesError(null)
    setScopesByUser({})
    if (!canManageScopes || !jwt || scopableUserIds.length === 0) {
      setMemberScopesReady(true)
      setLoadedMemberScopesKey(currentScopeKey)
      return
    }
    const results = await Promise.allSettled(
      scopableUserIds.map(async (userId) => {
        const scopes = await fetchMemberScopes(jwt, projectId, userId)
        return [userId, scopes ?? []] as const
      }),
    )
    if (scopeLoadRequestRef.current !== requestId) return
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failure) {
      setMemberScopesError(toUserFacingError(failure.reason, "member scopes").message)
      return
    }
    const entries = results.map((result) => (result as PromiseFulfilledResult<readonly [number, MemberScopeValue[]]>).value)
    setScopesByUser(Object.fromEntries(entries))
    setMemberScopesReady(true)
    setLoadedMemberScopesKey(currentScopeKey)
  }, [canManageScopes, currentScopeKey, jwt, projectId, scopableUserIds])

  useEffect(() => {
    void loadScopes()
    return () => { scopeLoadRequestRef.current += 1 }
  }, [loadScopes])

  const handleSaveScopes = useCallback(async (userId: number, scopes: MemberScopeValue[]) => {
    if (!jwt) throw new Error("Sign in to manage scopes.")
    const saved = await putMemberScopes(jwt, projectId, userId, scopes)
    setScopesByUser((prev) => ({ ...prev, [userId]: saved }))
  }, [jwt, projectId])

  const scopeConfig: MembersPanelScopeConfig | undefined = canManageScopes &&
    scopeOptionsReady && memberScopesReady &&
    loadedScopeOptionsKey === currentScopeKey && loadedMemberScopesKey === currentScopeKey
    ? { lanes: scopeLanes, files: scopeFiles, scopesByUser, onSave: handleSaveScopes }
    : undefined
  const scopeError = scopeOptionsError ?? memberScopesError
  const supplementalErrors = Array.from(
    new Set([projectOrgError, suggestionsError, scopeError].filter((message): message is string => Boolean(message))),
  )

  return (
    <div>
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      {supplementalErrors.map((message) => (
        <p key={message} role="alert" className="mb-2 text-xs text-destructive">
          {message}
        </p>
      ))}
      {isLoading && members.length === 0 ? (
        <div className="flex items-center text-muted-foreground">
          <Spinner className="size-3.5" />
        </div>
      ) : (
        <MembersPanel
          members={panelMembers}
          roleOptions={[...PROJECT_ROLE_OPTIONS]}
          newMemberDefaultRole={ROLE.CONTRIBUTOR}
          callerUserId={callerUserId}
          callerMaxRole={callerMaxRole}
          onAdd={async (usernames, role) => {
            const results = await addMany(usernames.map((username) => ({ username, role })))
            return results.map((r) => ({
              username: r.username,
              ok: r.ok,
              error: r.error?.message,
            }))
          }}
          onRemove={remove}
          onChangeRole={async (username, role) => { await add(username, role) }}
          scopeConfig={scopeConfig}
          suggestions={suggestions}
          emptySuggestionsHint={t("projectSettings.share.emptySuggestionsHint")}
        />
      )}
    </div>
  )
}

interface InviteLinkTabProps {
  projectId: string
  onSharesChanged?: () => void
}

/**
 * Mints a server-side project_invites row and shows the joinable URL once.
 * Active (unused + unexpired) invites are listed below with a revoke button.
 */
/** Expiry options: days (number) or null = no expiry. Server default is 30 days. */
const EXPIRY_OPTIONS: { labelKey: MessageKey; value: number | null }[] = [
  { labelKey: "projectSettings.share.expiryOneDay", value: 1 },
  { labelKey: "projectSettings.share.expirySevenDays", value: 7 },
  { labelKey: "projectSettings.share.expiryThirtyDaysDefault", value: 30 },
  { labelKey: "common.noExpiry", value: null },
]
const DEFAULT_EXPIRY_DAYS = 30

function InviteLinkTab({ projectId, onSharesChanged }: InviteLinkTabProps) {
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
  // Bump this to trigger the active-invites list to re-fetch after a new invite is created.
  const [inviteListVersion, setInviteListVersion] = useState(0)

  async function handleCreate() {
    setEmailError(null)
    setServerError(null)
    setIssuedUrl(null)
    const trimmedEmail = inviteEmail.trim()
    if (trimmedEmail.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setEmailError(t("projectSettings.share.inviteEmailInvalid"))
      return
    }
    if (!session?.jwt) {
      setServerError(t("projectSettings.share.signInToInvite"))
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
        expiresInDays
      )
      if (!serverInvite) {
        setServerError(t("projectSettings.share.createInviteFailed"))
        return
      }
      const url = `${window.location.origin}/join/${serverInvite.token}`
      setIssuedUrl(url)
      posthog.capture(INVITE_SENT, {
        project_id: projectId,
        role: inviteRole,
        has_email: Boolean(trimmedEmail),
      })
      setInviteListVersion((v) => v + 1)
      onSharesChanged?.()
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

  return (
    <div className="space-y-4">
      {issuedUrl ? (
        <div className="space-y-3">
          <p className="text-sm">{t("projectSettings.share.inviteLinkReady")}</p>
          <div className="flex items-center gap-1">
            <Input value={issuedUrl} readOnly className="text-xs font-mono" />
            <AppTooltip content={t("projectSettings.share.copyUrlLabel")}>
              <Button size="sm" variant="ghost" onClick={() => copyUrl(issuedUrl)} aria-label={t("projectSettings.share.copyUrlLabel")}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </AppTooltip>
          </div>
          {copied && <p className="text-xs text-green-600">{t("projectSettings.share.copied")}</p>}
          <p className="text-[10px] text-muted-foreground">
            {t("projectSettings.share.recipientJoinsAs", {
              role: (() => {
                const opt = LINK_ROLE_OPTIONS.find((o) => o.level === inviteRole)
                return opt ? roleDisplayLabel(opt.level) : t("projectSettings.share.recipientJoinsAsFallbackRole")
              })(),
            })}{" "}
            <RichMessage
              k="projectSettings.share.singleUseNote"
              values={{
                createAnotherLink: (
                  <strong className="font-medium">{t("projectSettings.share.createAnotherLinkButton")}</strong>
                ),
              }}
            />{" "}
            {t("projectSettings.share.revokeBeforeRedeemedNote")}
          </p>
          <Button size="sm" variant="outline" onClick={reset} className="w-full">
            {t("projectSettings.share.createAnotherLinkButton")}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <FieldLabel className="text-xs">{t("common.roleLabel")}</FieldLabel>
            <RoleSelect
              options={LINK_ROLE_OPTIONS}
              value={inviteRole}
              onValueChange={setInviteRole}
              disabled={!session?.jwt}
              aria-label={t("common.roleLabel")}
            />
            <p className="text-[10px] text-muted-foreground">
              {session?.jwt
                ? (() => {
                    const opt = LINK_ROLE_OPTIONS.find((o) => o.level === inviteRole)
                    return opt ? t(opt.descriptionKey) : ""
                  })()
                : t("projectSettings.share.signInToCreateLink")}
            </p>
          </div>
          <div className="space-y-1">
            <FieldLabel htmlFor="invite-email" className="text-xs">
              {t("projectSettings.share.recipientEmailLabel")} <OptionalMark />
            </FieldLabel>
            <Input
              id="invite-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              value={inviteEmail}
              onChange={(e) => {
                setInviteEmail(e.target.value)
                setEmailError(null)
              }}
              placeholder={t("projectSettings.share.emailPlaceholder")}
              disabled={!session?.jwt}
            />
            {emailError ? (
              <p className="text-[10px] text-destructive">{emailError}</p>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                {inviteEmail.trim()
                  ? t("projectSettings.share.emailRestrictedNote")
                  : t("projectSettings.share.openLinkNote")}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <FieldLabel className="text-xs">{t("projectSettings.share.linkExpiresLabel")}</FieldLabel>
            <Select
              items={EXPIRY_OPTIONS.map((opt) => ({
                value: String(opt.value),
                label: t(opt.labelKey),
              }))}
              value={expiresInDays === null ? "null" : String(expiresInDays)}
              onValueChange={(v) =>
                setExpiresInDays(v === "null" || v === null ? null : Number(v))
              }
              disabled={!session?.jwt}
            >
              <SelectTrigger className="w-full" aria-label={t("projectSettings.share.linkExpiresLabel")}>
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
            <p className="flex items-start gap-1 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{serverError}</span>
            </p>
          )}
          <Button
            onClick={handleCreate}
            disabled={busy || !session?.jwt}
            className="w-full"
          >
            {busy ? t("common.creating") : t("projectSettings.share.createInviteLinkButton")}
          </Button>
        </div>
      )}

      {session?.jwt && (
        <ActiveInvitesList
          projectId={projectId}
          jwt={session.jwt}
          version={inviteListVersion}
          onRevoked={() => setInviteListVersion((v) => v + 1)}
        />
      )}
    </div>
  )
}

// ── Active invites list ───────────────────────────────────────────────────

interface ActiveInvitesListProps {
  projectId: string
  jwt: string
  /** Incrementing this value triggers a re-fetch. */
  version: number
  onRevoked: () => void
}

function ActiveInvitesList({ projectId, jwt, version, onRevoked }: ActiveInvitesListProps) {
  const { locale } = useI18n()
  const t = useT()
  const [invites, setInvites] = useState<ActiveProjectInvite[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)
  const [revokeConfirm, setRevokeConfirm] = useState(false)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listProjectInvites(jwt, projectId)
      setInvites(list)
    } finally {
      setLoading(false)
    }
  }, [jwt, projectId])

  useEffect(() => {
    void load()
  }, [load, version])

  async function handleRevoke(token: string) {
    setRevoking(true)
    try {
      await revokeProjectInvite(jwt, projectId, token)
      setRevokeTarget(null)
      setRevokeConfirm(false)
      onRevoked()
    } finally {
      setRevoking(false)
    }
  }

  function formatExpiry(expiresAt: string | null) {
    if (!expiresAt) return t("common.noExpiry")
    return (
      <DateTooltip value={expiresAt} label={t("common.date.expires")}>
        {t("common.expiresOn", {
          date: fmtShortCalendarDate(expiresAt, undefined, locale),
        })}
      </DateTooltip>
    )
  }

  if (loading && !invites) {
    return <p className="text-[10px] text-muted-foreground">{t("projectSettings.share.loadingActiveLinks")}</p>
  }
  if (!invites || invites.length === 0) {
    return null
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs font-medium">{t("projectSettings.share.activeLinksHeading")}</p>
      <ul className="space-y-1.5">
        {invites.map((inv) => (
          <li key={inv.token} className="flex items-start justify-between gap-2 rounded border px-2 py-1.5">
            <div className="min-w-0">
              <p className="truncate text-[11px] font-mono text-muted-foreground">
                …{inv.token.slice(-8)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                <RoleLabel name={inv.role.name} />
                {inv.email ? ` · ${inv.email}` : ` · ${t("projectSettings.share.openLinkConnector")}`}
                {" · "}
                {formatExpiry(inv.expiresAt)}
              </p>
            </div>
            {revokeTarget === inv.token ? (
              <div className="flex shrink-0 items-center gap-1">
                <label className="flex items-center gap-1 text-[10px] text-destructive">
                  <Checkbox
                    className="size-3"
                    checked={revokeConfirm}
                    onCheckedChange={(checked) => setRevokeConfirm(checked)}
                  />
                  {t("common.confirm")}
                </label>
                <Button
                  variant="destructive"
                  className="h-6 px-2 text-[10px]"
                  disabled={!revokeConfirm || revoking}
                  onClick={() => void handleRevoke(inv.token)}
                >
                  {revoking ? "…" : t("common.revoke")}
                </Button>
                <Button
                  variant="ghost"
                  className="h-6 px-1 text-[10px]"
                  onClick={() => { setRevokeTarget(null); setRevokeConfirm(false) }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            ) : (
              <AppTooltip content={t("projectSettings.share.revokeLinkAriaLabel")}>
                <Button
                  variant="ghost"
                  className="h-6 shrink-0 px-1 text-muted-foreground hover:text-destructive"
                  onClick={() => { setRevokeTarget(inv.token); setRevokeConfirm(false) }}
                  aria-label={t("projectSettings.share.revokeLinkAriaLabel")}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </AppTooltip>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
