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
import { RoleSelect } from "@/components/RoleSelect"
import { createOrgInvite } from "@/lib/frontier/orgs"
import { ROLE, ORG_ROLE_OPTIONS } from "@/lib/frontier/roles"
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
      setError("Enter a valid email, or leave blank for an open link.")
      return
    }
    if (!jwt) {
      setError("Sign in to invite teammates.")
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
        trimmed ? `Invitation sent to ${trimmed}.` : "Invite link created — share it below.",
      )
      setEmail("")
    } catch {
      setError("Couldn't create the invite. You may not have permission, or the server is unreachable.")
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
          <FieldLabel htmlFor="org-invite-email">Invitee email</FieldLabel>
          <Input
            id="org-invite-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com (optional)"
            className="h-9"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="org-invite-role">Org role</FieldLabel>
          <RoleSelect
            id="org-invite-role"
            options={ORG_ROLE_OPTIONS}
            value={role}
            onValueChange={setRole}
            aria-label="Org role"
          />
        </Field>
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy ? "Sending…" : "Send invite"}
        </Button>
      </FieldGroup>
      {error && <FieldError className="text-xs">{error}</FieldError>}
      {status && <p className="text-xs text-muted-foreground">{status}</p>}
      {link && (
        <div className="flex items-center gap-2">
          <code className="truncate rounded bg-muted px-2 py-1 text-[11px]">{link}</code>
          <Button size="sm" variant="outline" onClick={copyLink}>
            <Copy className="mr-1 size-3.5" />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
    </div>
  )
}
