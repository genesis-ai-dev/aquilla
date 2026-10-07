import { useEffect, useRef, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { AgentAccessFields, useAgentAccess } from "@/components/agent-access/AgentAccessFields"
import { useT } from "@/lib/i18n/I18nProvider"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { fetchAccessibleProjectsResult, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { buildApprovedMessage, connectionRequest, type AgentConnectionRequest } from "@/lib/sync/agent-connect"
import { AUTH_BASE } from "@/lib/frontier/auth"

export function ConnectAgent() {
  const { session } = useFrontierSession()
  const { hash } = useLocation()
  return <ConnectAgentContent key={`${session?.jwt ?? "signed-out"}:${hash}`} />
}

function ConnectAgentContent() {
  const t = useT()
  const { hash } = useLocation()
  const { session, loading } = useFrontierSession()
  const jwt = session?.jwt
  const [code, setCode] = useState(() => new URLSearchParams(hash.slice(1)).get("user_code") ?? "")
  const [request, setRequest] = useState<AgentConnectionRequest | null>(null)
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const pinnedProjectId = request?.requestedProjectId ?? null
  const access = useAgentAccess(projects, orgs, pinnedProjectId)
  const { setMode, setScopeKind, setProjectId, setOrgId } = access
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [result, setResult] = useState<"approved" | "denied" | null>(null)
  const [copied, setCopied] = useState(false)
  const inFlight = useRef(false)
  // Account changes invalidate the loaded consent and selected scope.
  useEffect(() => {
    setRequest(null); setOrgs([]); setProjects([]); setProjectId(""); setOrgId("")
    setConfirmed(false); setResult(null)
  }, [jwt, setProjectId, setOrgId])
  async function review() {
    if (!jwt || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(false)
    try {
      const data = await connectionRequest<AgentConnectionRequest>(jwt, "request", { user_code: code.toUpperCase().trim() })
      const [directory, myOrgs] = await Promise.all([fetchAccessibleProjectsResult(jwt), listMyOrgs(jwt)])
      if (!directory.ok) throw new Error("projects")
      setProjects(directory.projects); setOrgs(myOrgs)
      setMode(data.mode); setScopeKind("project")
      setProjectId(data.requestedProjectId ?? ""); setOrgId(""); setRequest(data)
    } catch { setError(true) }
    finally { setBusy(false); inFlight.current = false }
  }
  async function decide(approve: boolean) {
    if (!jwt || !request || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(false)
    try {
      await connectionRequest(jwt, "decision", { user_code: code.toUpperCase().trim(), approve,
        ...(approve ? { mode: access.mode, ...access.scopeBody, code_confirmed: confirmed } : {}) })
      setResult(approve ? "approved" : "denied")
    } catch { setError(true) }
    finally { setBusy(false); inFlight.current = false }
  }
  return <main data-ph-mask className="flex min-h-screen items-center justify-center p-4">
    <Card className="w-full max-w-lg">
      <CardHeader><CardTitle>{t("onboarding.connect.title")}</CardTitle>
        <CardDescription>{t("onboarding.connect.description")}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? <Spinner /> : !session ? <FrontierLoginForm onSuccess={() => {}} /> : result ? <>
          <p role="status">{t(result === "approved" ? "onboarding.connect.approved" : "onboarding.connect.denied")}</p>
          {result === "approved" && <Field>
            <FieldLabel htmlFor="approved-message">{t("onboarding.connect.handoff")}</FieldLabel>
            <Textarea id="approved-message" readOnly rows={5} value={buildApprovedMessage(AUTH_BASE, code.toUpperCase().trim())} />
            <Button variant="outline" onClick={() => {
              void navigator.clipboard.writeText(buildApprovedMessage(AUTH_BASE, code.toUpperCase().trim()))
                .then(() => setCopied(true), () => setCopied(false))
            }}>{t(copied ? "onboarding.connect.handoffCopied" : "onboarding.connect.handoffCopy")}</Button>
          </Field>}
          <Link to="/preferences/api-tokens?awaiting=1">{t("onboarding.connect.manage")}</Link>
        </> : <>
          <p>{t("onboarding.connect.account", { username: session.username })}</p>
          {!request ? <form onSubmit={e => { e.preventDefault(); void review() }}>
            <FieldGroup><Field><FieldLabel htmlFor="connection-code">{t("onboarding.connect.code")}</FieldLabel>
              <Input id="connection-code" value={code} onChange={e => setCode(e.target.value)} autoComplete="off" maxLength={9} />
            </Field><Button type="submit" disabled={busy || !code.trim()}>{t("onboarding.connect.review")}</Button></FieldGroup>
          </form> : <>
            <p>{t("onboarding.connect.agent", { name: request.agentName })}</p>
            <p className="text-sm text-muted-foreground">{t("onboarding.connect.unverified")}</p>
            <FieldGroup>
              <AgentAccessFields access={access} requestedMode={request.mode} pinnedProjectId={pinnedProjectId} busy={busy}
                askHint={t("onboarding.connect.ask")} actHint={t("onboarding.connect.act")} />
              <p className="text-sm text-muted-foreground">{t("onboarding.connect.expiry")}</p>
              <Field orientation="horizontal"><Checkbox id="confirm-code" checked={confirmed} onCheckedChange={v => setConfirmed(v === true)} />
                <FieldLabel htmlFor="confirm-code">{t("onboarding.connect.confirm", { code })}</FieldLabel></Field>
            </FieldGroup>
            <div className="flex gap-2">
              <Button disabled={busy || !confirmed || !access.scopeChosen} onClick={() => void decide(true)}>{t("onboarding.connect.approve")}</Button>
              <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>{t("onboarding.connect.deny")}</Button>
            </div>
          </>}
        </>}
        {error && <p role="alert">{t("onboarding.connect.error")}</p>}
      </CardContent>
    </Card>
  </main>
}
