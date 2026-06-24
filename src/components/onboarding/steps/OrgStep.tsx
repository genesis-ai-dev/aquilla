import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createOrg, createOrgInvite } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useActiveOrg } from "@/context/OrgContext"
import posthog from "@/lib/posthog"
import { ORG_CREATED, INVITE_SENT } from "@/lib/analytics-events"

/**
 * Team-onboarding step: name the organization and (optionally) invite the first
 * collaborators by email in the same breath — embedding invitations into setup
 * is the single highest-signal predictor of team activation. Invites are
 * best-effort; a failed one never blocks org creation. On success the new org
 * becomes active so the following ProjectStep creates the first project inside
 * it.
 */
export function OrgStep({
  onCreated,
  onBack,
}: {
  onCreated: (orgId: number) => void
  onBack: () => void
}) {
  const { session } = useFrontierSession()
  const { refresh, setActiveOrg } = useActiveOrg()
  const [name, setName] = useState("")
  const [emails, setEmails] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    if (!session?.jwt) {
      setError("Sign in to create an organization.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const org = await createOrg(session.jwt, name.trim())
      posthog.capture(ORG_CREATED, { org_id: org.id, source: "onboarding" })

      // Best-effort invites — individual failures don't block onboarding.
      const list = emails
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
      for (const email of list) {
        try {
          await createOrgInvite(session.jwt, org.id, { email })
          posthog.capture(INVITE_SENT, {
            scope: "org",
            org_id: org.id,
            has_email: true,
            source: "onboarding",
          })
        } catch {
          /* skip this invite; keep going */
        }
      }

      await refresh()
      setActiveOrg(org.id)
      onCreated(org.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create your organization.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold">Set up your organization</h2>
        <p className="text-sm text-muted-foreground">
          Give your team a home, and invite collaborators to get started together.
        </p>
      </div>
      <form onSubmit={handleCreate} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="org-name">Organization name</Label>
          <Input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Bible Translation"
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="org-emails">Invite teammates (optional)</Label>
          <Input
            id="org-emails"
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            placeholder="alex@example.com, sam@example.com"
          />
          <p className="text-xs text-muted-foreground">
            Comma- or space-separated emails. They'll get a link to join.
          </p>
        </div>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="lg" className="w-full" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create organization"}
        </Button>
      </form>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        ← Back
      </Button>
    </div>
  )
}
