import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation } from "react-router-dom"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { FieldGroup } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { AgentAccessFields, useAgentAccess } from "@/components/agent-access/AgentAccessFields"
import { useT } from "@/lib/i18n/I18nProvider"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { fetchAccessibleProjectsResult, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { leaveForClient, mcpOAuthCall, type McpOAuthClient } from "@/lib/sync/agent-connect"

// Consent for MCP hosts (ChatGPT plugin, Claude, Codex) using OAuth 2.1 +
// PKCE. The identity worker's /oauth/authorize sends the browser here with the
// client's request in the query string; every decision is re-validated by the
// server, so this page only describes the request and collects the choice.
// The authorization code travels in the redirect URL and is never stored.

/** The OAuth parameters the server needs back; anything else is dropped. */
const AUTHORIZE_PARAMS = [
  "response_type", "client_id", "redirect_uri", "code_challenge",
  "code_challenge_method", "state", "scope", "resource",
] as const

export function OAuthConsent() {
  const { session } = useFrontierSession()
  return <OAuthConsentContent key={session?.jwt ?? "signed-out"} />
}

function OAuthConsentContent() {
  const t = useT()
  const { search } = useLocation()
  const { session, loading } = useFrontierSession()
  const jwt = session?.jwt
  const params = useMemo(() => {
    const query = new URLSearchParams(search)
    const entries: [string, string][] = AUTHORIZE_PARAMS.flatMap((k) => (query.has(k) ? [[k, query.get(k) ?? ""]] : []))
    return Object.fromEntries(entries)
  }, [search])
  const [client, setClient] = useState<McpOAuthClient | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const access = useAgentAccess(projects, orgs, null)
  const { setMode } = access
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const inFlight = useRef(false)

  // Describe the request as soon as someone is signed in. Errors the client
  // must hear about (bad PKCE, wrong response_type) go straight back to it.
  useEffect(() => {
    if (!jwt) return
    let cancelled = false
    void (async () => {
      try {
        const described = await mcpOAuthCall<McpOAuthClient>(jwt, "request", params)
        if (cancelled) return
        if (!described.ok) {
          if (described.redirect) { setLeaving(true); leaveForClient(described.redirect) }
          else setInvalid(true)
          return
        }
        const [directory, myOrgs] = await Promise.all([fetchAccessibleProjectsResult(jwt), listMyOrgs(jwt)])
        if (cancelled) return
        if (!directory.ok) throw new Error("projects")
        setProjects(directory.projects); setOrgs(myOrgs)
        setMode(described.data.mode); setClient(described.data)
      } catch {
        if (!cancelled) setError(true)
      }
    })()
    return () => { cancelled = true }
  }, [jwt, params, setMode])

  async function decide(approve: boolean) {
    if (!jwt || !client || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(false)
    try {
      const result = await mcpOAuthCall<{ redirect: string }>(jwt, "decision", {
        ...params, approve, ...(approve ? { mode: access.mode, ...access.scopeBody } : {}),
      })
      const redirect = result.ok ? result.data.redirect : result.redirect
      if (redirect) { setLeaving(true); leaveForClient(redirect); return }
      setError(true)
    } catch { setError(true) }
    finally { setBusy(false); inFlight.current = false }
  }

  return <main data-ph-mask className="flex min-h-screen items-center justify-center p-4">
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>{client ? t("onboarding.oauth.title", { client: client.clientName }) : t("onboarding.oauth.titleGeneric")}</CardTitle>
        <CardDescription>{t("onboarding.oauth.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? <Spinner /> : !session ? <FrontierLoginForm onSuccess={() => {}} /> : invalid ? (
          <p role="alert">{t("onboarding.oauth.invalid")}</p>
        ) : leaving ? (
          <p role="status">{t("onboarding.oauth.redirecting", { host: client?.redirectHost ?? "" })}</p>
        ) : !client ? (error ? null : <Spinner />) : <>
          <p>{t("onboarding.connect.account", { username: session.username })}</p>
          <p className="text-sm text-muted-foreground">{t("onboarding.oauth.verified", { host: client.clientHost })}</p>
          <FieldGroup>
            <AgentAccessFields access={access} requestedMode={client.mode} pinnedProjectId={null} busy={busy}
              askHint={t("onboarding.connect.ask")} actHint={t("onboarding.connect.act")} />
            <p className="text-sm text-muted-foreground">{t("onboarding.connect.expiry")}</p>
            <p className="text-sm text-muted-foreground">{t("onboarding.oauth.return", { host: client.redirectHost })}</p>
          </FieldGroup>
          <div className="flex gap-2">
            <Button disabled={busy || !access.scopeChosen} onClick={() => void decide(true)}>{t("onboarding.oauth.approve")}</Button>
            <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>{t("onboarding.connect.deny")}</Button>
          </div>
        </>}
        {error && <p role="alert">{t("onboarding.connect.error")}</p>}
      </CardContent>
    </Card>
  </main>
}
