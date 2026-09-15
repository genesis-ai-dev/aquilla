import { useEffect, useRef, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { fetchAccessibleProjectsResult, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { connectionRequest, type AgentConnectionRequest } from "@/lib/sync/agent-connect"

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
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [projectId, setProjectId] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [result, setResult] = useState<"approved" | "denied" | null>(null)
  const inFlight = useRef(false)
  // Account changes invalidate the loaded consent and selected scope.
  useEffect(() => {
    setRequest(null); setProjects([]); setProjectId(""); setConfirmed(false); setResult(null)
  }, [jwt])
  async function review() {
    if (!jwt || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(false)
    try {
      const data = await connectionRequest<AgentConnectionRequest>(jwt, "request", { user_code: code.toUpperCase().trim() })
      const directory = await fetchAccessibleProjectsResult(jwt)
      if (!directory.ok) throw new Error("projects")
      const available = directory.projects.filter(p => p.role.level >= (data.mode === "act" ? 600 : 400)
        && (!data.requestedProjectId || p.id === data.requestedProjectId))
      setProjects(available); setProjectId(data.requestedProjectId ?? ""); setRequest(data)
    } catch { setError(true) }
    finally { setBusy(false); inFlight.current = false }
  }
  async function decide(approve: boolean) {
    if (!jwt || !request || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(false)
    try {
      await connectionRequest(jwt, "decision", { user_code: code.toUpperCase().trim(), approve,
        ...(approve ? { project_id: projectId, code_confirmed: confirmed } : {}) })
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
          <Link to="/preferences/api-tokens">{t("onboarding.connect.manage")}</Link>
        </> : <>
          <p>{t("onboarding.connect.account", { username: session.username })}</p>
          {!request ? <form onSubmit={e => { e.preventDefault(); void review() }}>
            <FieldGroup><Field><FieldLabel htmlFor="connection-code">{t("onboarding.connect.code")}</FieldLabel>
              <Input id="connection-code" value={code} onChange={e => setCode(e.target.value)} autoComplete="off" maxLength={9} />
            </Field><Button type="submit" disabled={busy || !code.trim()}>{t("onboarding.connect.review")}</Button></FieldGroup>
          </form> : <>
            <p>{t("onboarding.connect.agent", { name: request.agentName })}</p>
            <p className="text-sm text-muted-foreground">{t("onboarding.connect.unverified")}</p>
            <p>{t(request.mode === "ask" ? "onboarding.connect.ask" : "onboarding.connect.act")}</p>
            <p className="text-sm text-muted-foreground">{t("onboarding.connect.expiry")}</p>
            <FieldGroup><Field><FieldLabel>{t("onboarding.connect.project")}</FieldLabel>
              <Select value={projectId} onValueChange={v => setProjectId(v ?? "")} disabled={busy}>
                <SelectTrigger aria-label={t("onboarding.connect.project")}><SelectValue placeholder={t("onboarding.connect.choose")}>{projects.find(p => p.id === projectId)?.name}</SelectValue></SelectTrigger>
                <SelectContent><SelectGroup>{projects.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
            {!projects.length && <p role="status">{t("onboarding.connect.noProjects")}</p>}
            <Field orientation="horizontal"><Checkbox id="confirm-code" checked={confirmed} onCheckedChange={v => setConfirmed(v === true)} />
              <FieldLabel htmlFor="confirm-code">{t("onboarding.connect.confirm", { code })}</FieldLabel></Field></FieldGroup>
            <div className="flex gap-2">
              <Button disabled={busy || !confirmed || !projects.some(p => p.id === projectId)} onClick={() => void decide(true)}>{t("onboarding.connect.approve")}</Button>
              <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>{t("onboarding.connect.deny")}</Button>
            </div>
          </>}
        </>}
        {error && <p role="alert">{t("onboarding.connect.error")}</p>}
      </CardContent>
    </Card>
  </main>
}
