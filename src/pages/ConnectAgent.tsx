import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { Building2, Folder } from "lucide-react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { ROLE } from "@/lib/frontier/roles"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { fetchAccessibleProjectsResult, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { connectionRequest, type AgentConnectionRequest } from "@/lib/sync/agent-connect"

type Mode = "ask" | "act"
type ScopeKind = "project" | "org"

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
  // The human is the authority: the agent's requested mode is only the default.
  const [mode, setMode] = useState<Mode>("ask")
  const [scopeKind, setScopeKind] = useState<ScopeKind>("project")
  const [orgId, setOrgId] = useState("")
  const [projectId, setProjectId] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [result, setResult] = useState<"approved" | "denied" | null>(null)
  const inFlight = useRef(false)
  // Account changes invalidate the loaded consent and selected scope.
  useEffect(() => {
    setRequest(null); setOrgs([]); setProjects([]); setProjectId(""); setOrgId("")
    setConfirmed(false); setResult(null)
  }, [jwt])
  // A requested project is PINNED: the human may approve exactly that project
  // or deny. Widening it to a whole org would grant more than was reviewed.
  const pinnedProjectId = request?.requestedProjectId ?? null
  const floor = mode === "act" ? ROLE.MAINTAINER : ROLE.CONTRIBUTOR
  const projectOptions = useMemo(
    () => projects.filter(p => p.role.level >= floor && (!pinnedProjectId || p.id === pinnedProjectId)),
    [projects, floor, pinnedProjectId],
  )
  const orgOptions = useMemo(
    () => (pinnedProjectId ? [] : orgs.filter(o => o.role.level >= floor)),
    [orgs, floor, pinnedProjectId],
  )
  // Clear a selection the mode change just made ineligible, so the button can
  // never submit a scope the server will refuse.
  useEffect(() => {
    if (projectId && !projectOptions.some(p => p.id === projectId)) setProjectId("")
  }, [projectId, projectOptions])
  useEffect(() => {
    if (orgId && !orgOptions.some(o => String(o.id) === orgId)) setOrgId("")
  }, [orgId, orgOptions])
  const scopeChosen = scopeKind === "project"
    ? projectOptions.some(p => p.id === projectId)
    : orgOptions.some(o => String(o.id) === orgId)
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
        ...(approve ? {
          mode,
          ...(scopeKind === "project" ? { project_id: projectId } : { org_id: orgId }),
          code_confirmed: confirmed,
        } : {}) })
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
              <Field>
                <FieldLabel>{t("common.modeLabel")}</FieldLabel>
                <RadioGroup value={mode} onValueChange={v => setMode(v === "act" ? "act" : "ask")} disabled={busy}>
                  <Field orientation="horizontal">
                    <RadioGroupItem id="connect-mode-ask" value="ask" />
                    <FieldLabel htmlFor="connect-mode-ask" className="font-normal">
                      <strong>{t("onboarding.apiTokens.modeAskLabel")}</strong> — {t("onboarding.connect.ask")}
                    </FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <RadioGroupItem id="connect-mode-act" value="act" />
                    <FieldLabel htmlFor="connect-mode-act" className="font-normal">
                      <strong>{t("onboarding.apiTokens.modeActLabel")}</strong> — {t("onboarding.connect.act")}
                    </FieldLabel>
                  </Field>
                </RadioGroup>
                {mode !== request.mode && <FieldDescription>{t("onboarding.connect.modeChanged", { requested: request.mode })}</FieldDescription>}
              </Field>
              {pinnedProjectId ? (
                <Field>
                  <FieldLabel>{t("onboarding.connect.project")}</FieldLabel>
                  <p className="flex items-center gap-1.5 text-sm">
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    {projectOptions[0]?.name ?? pinnedProjectId}
                  </p>
                  <FieldDescription>{t("onboarding.connect.pinned")}</FieldDescription>
                </Field>
              ) : <>
                <Field>
                  <FieldLabel>{t("onboarding.connect.scope")}</FieldLabel>
                  <RadioGroup value={scopeKind} onValueChange={v => setScopeKind(v === "org" ? "org" : "project")} disabled={busy}>
                    <Field orientation="horizontal">
                      <RadioGroupItem id="connect-scope-project" value="project" />
                      <FieldLabel htmlFor="connect-scope-project" className="font-normal">
                        <Folder className="me-1 inline size-3.5 align-[-2px] text-muted-foreground" aria-hidden />
                        {t("onboarding.connect.scopeProject")}
                      </FieldLabel>
                    </Field>
                    <Field orientation="horizontal">
                      <RadioGroupItem id="connect-scope-org" value="org" />
                      <FieldLabel htmlFor="connect-scope-org" className="font-normal">
                        <Building2 className="me-1 inline size-3.5 align-[-2px] text-muted-foreground" aria-hidden />
                        {t("onboarding.connect.scopeOrg")}
                      </FieldLabel>
                    </Field>
                  </RadioGroup>
                  <FieldDescription>{t("onboarding.connect.scopeHint")}</FieldDescription>
                </Field>
                {scopeKind === "project" ? (
                  <Field>
                    <FieldLabel>{t("onboarding.connect.project")}</FieldLabel>
                    <Select value={projectId} onValueChange={v => setProjectId(v ?? "")} disabled={busy}>
                      <SelectTrigger aria-label={t("onboarding.connect.project")}>
                        <SelectValue placeholder={t("onboarding.connect.choose")}>{projectOptions.find(p => p.id === projectId)?.name}</SelectValue>
                      </SelectTrigger>
                      <SelectContent><SelectGroup>{projectOptions.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectGroup></SelectContent>
                    </Select>
                    {!projectOptions.length && <p role="status">{t("onboarding.connect.noProjects")}</p>}
                  </Field>
                ) : (
                  <Field>
                    <FieldLabel>{t("onboarding.apiTokens.orgLabel")}</FieldLabel>
                    <Select value={orgId} onValueChange={v => setOrgId(v ?? "")} disabled={busy}>
                      <SelectTrigger aria-label={t("onboarding.apiTokens.orgLabel")}>
                        <SelectValue placeholder={t("onboarding.connect.chooseOrg")}>{orgOptions.find(o => String(o.id) === orgId)?.name}</SelectValue>
                      </SelectTrigger>
                      <SelectContent><SelectGroup>{orgOptions.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name ?? t("onboarding.apiTokens.scope.orgFallback", { id: o.id })}</SelectItem>)}</SelectGroup></SelectContent>
                    </Select>
                    {!orgOptions.length && <p role="status">{t("onboarding.connect.noOrgs")}</p>}
                  </Field>
                )}
              </>}
              <p className="text-sm text-muted-foreground">{t("onboarding.connect.expiry")}</p>
              <Field orientation="horizontal"><Checkbox id="confirm-code" checked={confirmed} onCheckedChange={v => setConfirmed(v === true)} />
                <FieldLabel htmlFor="confirm-code">{t("onboarding.connect.confirm", { code })}</FieldLabel></Field>
            </FieldGroup>
            <div className="flex gap-2">
              <Button disabled={busy || !confirmed || !scopeChosen} onClick={() => void decide(true)}>{t("onboarding.connect.approve")}</Button>
              <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>{t("onboarding.connect.deny")}</Button>
            </div>
          </>}
        </>}
        {error && <p role="alert">{t("onboarding.connect.error")}</p>}
      </CardContent>
    </Card>
  </main>
}
