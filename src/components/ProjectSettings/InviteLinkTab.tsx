// Project settings → Members → Add member → the invite-link tab.
//
// AQU-2259: moved out of the unrouted ProjectMembersPage, whose member list
// only the (unreachable) Share dialog used.

import { useState } from "react"
import { LinkIcon, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Input } from "@/components/ui/input"
import { FieldLabel, OptionalMark } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useCurrentTargetLanes } from "@/hooks/useCurrentTargetLanes"
import { LaneAccessFields } from "@/components/LaneAccessFields"
import { chosenLaneLabels, laneChoiceReady, needsLaneChoice, toMemberLaneAccess, type LaneAccessChoice } from "@/lib/lanes/lane-access-choice"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { createServerInviteWithChoice } from "@/lib/sync/invite-with-choice"
import { GrantScopeNotice } from "@/components/GrantScopeNotice"
import { toast } from "@/components/ui/toast"
import { describeGrant, grantButtonLabel, grantProjectName } from "@/lib/access/grant-scope-sentence"
import { ROLE, LINK_ROLE_OPTIONS, humanRoleName } from "@/lib/frontier/roles"
import { RoleSelect } from "@/components/RoleSelect"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_INVITE_ROLE = ROLE.CONTRIBUTOR
// Labels resolve via t() at render time (InviteLinkTab) rather than being
// hardcoded here, so they stay locale-reactive.
const EXPIRY_OPTIONS: { labelKey: MessageKey; value: number | null }[] = [
  { labelKey: "projectSettings.share.expiryOneDay", value: 1 },
  { labelKey: "org.membersPage.expiry7DaysDefault", value: 7 },
  { labelKey: "common.thirtyDays", value: 30 },
  { labelKey: "common.noExpiry", value: null },
]
const DEFAULT_EXPIRY_DAYS = 7

// ──────────────────────────────────────────────────────────────────────────
// Invite-link tab
// ──────────────────────────────────────────────────────────────────────────

export function InviteLinkTab({
  projectId,
  projectName,
  embedded = false,
}: {
  projectId: string
  projectName?: string | null
  /** When true (settings Card), drop the page-style max-width + duplicate title. */
  embedded?: boolean
}) {
  const { t, locale } = useI18n()
  const { session } = useFrontierSession()
  const [inviteRole, setInviteRole] = useState<number>(DEFAULT_INVITE_ROLE)
  const [inviteEmail, setInviteEmail] = useState<string>("")
  const [emailError, setEmailError] = useState<string | null>(null)
  const [expiresInDays, setExpiresInDays] = useState<number | null>(DEFAULT_EXPIRY_DAYS)
  const [busy, setBusy] = useState(false)
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const { lanes: targetLanes } = useCurrentTargetLanes(projectId)
  const [laneChoice, setLaneChoice] = useState<LaneAccessChoice | null>(null)
  const choiceReady = laneChoiceReady(laneChoice, inviteRole, targetLanes.length)
  const wrapClass = embedded ? "space-y-4" : "mx-auto max-w-lg space-y-4"
  const inviteCopy = describeGrant(t, {
    link: inviteEmail.trim().length === 0,
    names: inviteEmail.trim() ? [inviteEmail.trim()] : [],
    roleLevel: inviteRole,
    scope: {
      kind: "project",
      projectName: grantProjectName(t, projectName),
      lanes: chosenLaneLabels(targetLanes, inviteRole, laneChoice),
    },
    locale,
  })

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
    if (!choiceReady) {
      setServerError(t("projectSettings.share.laneChoiceRequired"))
      return
    }
    const laneAccess = needsLaneChoice(inviteRole, targetLanes.length) && laneChoice
      ? toMemberLaneAccess(laneChoice)
      : undefined
    setBusy(true)
    try {
      const serverInvite = await createServerInviteWithChoice(
        session.jwt,
        projectId,
        inviteRole,
        trimmedEmail || undefined,
        expiresInDays,
        laneAccess,
      )
      if (!serverInvite) {
        setServerError(t("projectSettings.share.createInviteFailed"))
        return
      }
      const url = `${window.location.origin}/join/${serverInvite.token}`
      setIssuedUrl(url)
      toast.add({ type: "success", title: inviteCopy.sentence })
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
    setLaneChoice(null)
  }

  if (issuedUrl) {
    return (
      <div className={wrapClass}>
        {!embedded && (
          <h2 className="text-sm font-medium flex items-center gap-2">
            <LinkIcon className="h-4 w-4 text-muted-foreground" />
            {t("org.membersPage.inviteLinkReadyHeading")}
          </h2>
        )}
        <p className="text-sm text-muted-foreground">
          {t("org.membersPage.inviteLinkReadyBody")}
        </p>
        <div className="flex items-center gap-1">
          <Input value={issuedUrl} readOnly className="text-xs font-mono" />
          <AppTooltip content={t("projectSettings.share.copyUrlLabel")}>
            <Button
              variant="ghost"
              onClick={() => copyUrl(issuedUrl)}
              aria-label={t("projectSettings.share.copyUrlLabel")}
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
              return opt ? humanRoleName(opt.level) : t("projectSettings.share.recipientJoinsAsFallbackRole")
            })(),
          })}
        </p>
        <Button variant="outline" onClick={reset} className="w-full">
          {t("projectSettings.share.createAnotherLinkButton")}
        </Button>
      </div>
    )
  }

  return (
    <div className={wrapClass}>
      {!embedded && (
        <h2 className="text-sm font-medium flex items-center gap-2">
          <LinkIcon className="h-4 w-4 text-muted-foreground" />
          {t("projectSettings.share.createInviteLinkButton")}
        </h2>
      )}

      <div className={cn("space-y-4", !embedded && "rounded border p-4")}>
        {/* Role */}
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

        {/* Optional email */}
        <div className="space-y-1">
          <FieldLabel htmlFor="pm-invite-email" className="text-xs">
            {t("org.membersPage.recipientEmailLabel")} <OptionalMark />
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
            placeholder={t("projectSettings.share.emailPlaceholder")}
            disabled={!session?.jwt}
          />
          {emailError ? (
            <p className="text-[10px] text-destructive">{emailError}</p>
          ) : (
            <p className="text-[10px] text-muted-foreground">
              {inviteEmail.trim()
                ? t("org.membersPage.emailPrefillHint")
                : t("projectSettings.share.openLinkNote")}
            </p>
          )}
        </div>

        {/* Expiry */}
        <div className="space-y-1">
          <FieldLabel className="text-xs">{t("projectSettings.share.linkExpiresLabel")}</FieldLabel>
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
          <p className="text-xs text-destructive">{serverError}</p>
        )}

        {needsLaneChoice(inviteRole, targetLanes.length) && (
          <LaneAccessFields
            lanes={targetLanes}
            value={laneChoice}
            onChange={setLaneChoice}
            disabled={!session?.jwt || busy}
          />
        )}
        <GrantScopeNotice sentence={inviteCopy.sentence} />
        <Button
          onClick={() => void handleCreate()}
          disabled={busy || !session?.jwt || !choiceReady}
          className="w-full"
        >
          {busy
            ? t("common.creating")
            : grantButtonLabel(t, t("projectSettings.share.createInviteLinkButton"), inviteCopy.scopeEcho)}
        </Button>
      </div>
    </div>
  )
}

