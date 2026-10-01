import { useEffect, useMemo, useState } from "react"
import { Building2, Folder } from "lucide-react"
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"
import { useT } from "@/lib/i18n/I18nProvider"
import { ROLE } from "@/lib/frontier/roles"
import type { OrgSummary } from "@/lib/frontier/orgs"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

// Mode + scope picker shared by the two agent-consent pages: the device flow
// (/connect-agent) and OAuth for MCP hosts such as ChatGPT (/oauth/consent).
// Both servers enforce the same rule — one project or one organization, at
// Contributor for ask and Maintainer for act — so the page offers only what
// the server will accept.

export type AgentMode = "ask" | "act"
type ScopeKind = "project" | "org"

export interface AgentAccess {
  mode: AgentMode
  setMode: (mode: AgentMode) => void
  scopeKind: ScopeKind
  setScopeKind: (kind: ScopeKind) => void
  projectId: string
  setProjectId: (id: string) => void
  setOrgId: (id: string) => void
  /** The selected org, or the only eligible one when there is just one. */
  effectiveOrgId: string
  projectOptions: CloudProjectSummary[]
  orgOptions: OrgSummary[]
  /** True when the chosen scope is one the server will accept. */
  scopeChosen: boolean
  /** The scope fields for the decision request body. */
  scopeBody: { project_id: string } | { org_id: string }
}

export function useAgentAccess(
  projects: CloudProjectSummary[],
  orgs: OrgSummary[],
  pinnedProjectId: string | null,
): AgentAccess {
  // The human is the authority: an agent's requested mode is only the default.
  const [mode, setMode] = useState<AgentMode>("ask")
  const [scopeKind, setScopeKind] = useState<ScopeKind>("project")
  const [orgId, setOrgId] = useState("")
  const [projectId, setProjectId] = useState("")
  const floor = mode === "act" ? ROLE.MAINTAINER : ROLE.CONTRIBUTOR
  // A requested project is PINNED: approve exactly that project or deny.
  // Widening it to a whole org would grant more than was reviewed.
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
  const effectiveOrgId = orgId || (orgOptions.length === 1 ? String(orgOptions[0].id) : "")
  const scopeChosen = scopeKind === "project"
    ? projectOptions.some(p => p.id === projectId)
    : orgOptions.some(o => String(o.id) === effectiveOrgId)
  return {
    mode, setMode, scopeKind, setScopeKind, projectId, setProjectId, setOrgId,
    effectiveOrgId, projectOptions, orgOptions, scopeChosen,
    scopeBody: scopeKind === "project" ? { project_id: projectId } : { org_id: effectiveOrgId },
  }
}

export function AgentAccessFields({ access, requestedMode, pinnedProjectId, busy, askHint, actHint }: {
  access: AgentAccess
  requestedMode: AgentMode
  pinnedProjectId: string | null
  busy: boolean
  /** What each mode means for this kind of client. */
  askHint: string
  actHint: string
}) {
  const t = useT()
  const { mode, setMode, scopeKind, setScopeKind, projectId, setProjectId, setOrgId,
    effectiveOrgId, projectOptions, orgOptions } = access
  return <>
    <Field>
      <FieldLabel>{t("common.modeLabel")}</FieldLabel>
      <RadioGroup value={mode} onValueChange={v => setMode(v === "act" ? "act" : "ask")} disabled={busy}>
        <Field orientation="horizontal">
          <RadioGroupItem id="connect-mode-ask" value="ask" />
          <FieldLabel htmlFor="connect-mode-ask" className="font-normal">
            <strong>{t("onboarding.apiTokens.modeAskLabel")}</strong> — {askHint}
          </FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <RadioGroupItem id="connect-mode-act" value="act" />
          <FieldLabel htmlFor="connect-mode-act" className="font-normal">
            <strong>{t("onboarding.apiTokens.modeActLabel")}</strong> — {actHint}
          </FieldLabel>
        </Field>
      </RadioGroup>
      {mode !== requestedMode && <FieldDescription>{t("onboarding.connect.modeChanged", { requested: requestedMode })}</FieldDescription>}
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
          <Select value={effectiveOrgId} onValueChange={v => setOrgId(v ?? "")} disabled={busy}>
            <SelectTrigger aria-label={t("onboarding.apiTokens.orgLabel")}>
              <SelectValue placeholder={t("onboarding.connect.chooseOrg")}>{orgOptions.find(o => String(o.id) === effectiveOrgId)?.name}</SelectValue>
            </SelectTrigger>
            <SelectContent><SelectGroup>{orgOptions.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name ?? t("onboarding.apiTokens.scope.orgFallback", { id: o.id })}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
          {!orgOptions.length && <p role="status">{t("onboarding.connect.noOrgs")}</p>}
        </Field>
      )}
    </>}
  </>
}
