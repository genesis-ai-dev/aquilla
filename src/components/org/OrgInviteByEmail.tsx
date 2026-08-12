import { useState } from "react"
import { Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { createOrgInvite } from "@/lib/frontier/orgs"
import { ROLE, ORG_ROLE_PICKER, resolveRoleName } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import posthog from "@/lib/posthog"
import { INVITE_SENT } from "@/lib/event-names"

/**
 * Owner-only: invite a teammate to the organization by EMAIL (not just by
 * existing username). Mints an org_invites token; if an email is given the
 * server emails a /join-org link, otherwise the owner copies an open link.
 * Server enforces owner-only — this UI is gated by the caller as a courtesy.
 */
export function OrgInviteByEmail({ orgId }: { orgId: number }) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<number>(ROLE.CONTRIBUTOR)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function submit() {
    setError(null)
    setStatus(null)
    setLink(null)
    const trimmed = email.trim()
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError(t("org.inviteByEmail.invalidEmailError"))
      return
    }
    if (!jwt) {
      setError(t("org.inviteByEmail.notSignedInError"))
      return
    }
    setBusy(true)
    try {
      const result = await createOrgInvite(jwt, orgId, {
        email: trimmed || undefined,
        role,
      })
      posthog.capture(INVITE_SENT, {
        scope: "org",
        org_id: orgId,
        role,
        has_email: Boolean(trimmed),
      })
      setLink(`${window.location.origin}/join-org/${result.token}`)
      setStatus(
        trimmed
          ? t("org.inviteByEmail.sentToEmail", { email: trimmed })
          : t("org.inviteByEmail.linkCreated"),
      )
      setEmail("")
    } catch {
      setError(t("org.inviteByEmail.createError"))
    } finally {
      setBusy(false)
    }
  }

  function copyLink() {
    if (!link) return
    void navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="space-y-3">
      <FieldGroup className="flex-row flex-wrap items-end gap-2">
        <Field className="w-64">
          <FieldLabel htmlFor="org-invite-email">{t("org.inviteByEmail.emailLabel")}</FieldLabel>
          <Input
            id="org-invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("org.inviteByEmail.emailPlaceholder")}
            className="h-9"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="org-invite-role">{t("org.inviteByEmail.roleLabel")}</FieldLabel>
          <select
            id="org-invite-role"
            value={role}
            onChange={(e) => setRole(Number(e.target.value))}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            {ORG_ROLE_PICKER.map((level) => (
              <option key={level} value={level}>
                {resolveRoleName(t, level)}
              </option>
            ))}
          </select>
        </Field>
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy ? t("org.inviteByEmail.sending") : t("org.inviteByEmail.submit")}
        </Button>
      </FieldGroup>
      {error && <FieldError className="text-xs">{error}</FieldError>}
      {status && <p className="text-xs text-muted-foreground">{status}</p>}
      {link && (
        <div className="flex items-center gap-2">
          <code className="truncate rounded bg-muted px-2 py-1 text-[11px]">{link}</code>
          <Button size="sm" variant="outline" onClick={copyLink}>
            <Copy className="me-1 size-3.5" />
            {copied ? t("nav.version.copiedLabel") : t("org.inviteByEmail.copyButton")}
          </Button>
        </div>
      )}
    </div>
  )
}
