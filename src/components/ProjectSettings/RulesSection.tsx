/**
 * Self-contained Rules pane for Project Settings.
 *
 * Rules used to render inside the workspace overlay (`/project/:id/rules`).
 * The settings pane owns its own data (project, rules, org rules, cells) so
 * it does not depend on the editor shell staying mounted.
 */
import { useCallback, useMemo, useState } from "react"
import { useActiveOrgOptional } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { useProject } from "@/hooks/useProject"
import { useProjectCells } from "@/hooks/useProjectCells"
import { useRules } from "@/hooks/useRules"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import type { RuleInfraction } from "@/lib/parsers/types"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { RulesSurface } from "@/components/RulesSurface"

export function RulesSettingsSection({ projectId }: { projectId: string }) {
  const [editingRuleId, setEditingRuleId] = useState<string | "new" | null>(null)
  const { project, loading, refresh, patchSettings, roleLevel } = useProject(projectId)
  const { session } = useFrontierSession()
  const orgCtx = useActiveOrgOptional()

  const projectOrg = useMemo(() => {
    if (project?.orgId == null) return orgCtx?.activeOrg ?? null
    if (orgCtx?.activeOrg?.id === project.orgId) return orgCtx.activeOrg
    return orgCtx?.orgs.find((org) => org.id === project.orgId) ?? null
  }, [orgCtx?.activeOrg, orgCtx?.orgs, project?.orgId])

  const {
    orgRules,
    promotionRequests,
    canEdit: canEditOrgSettings,
    canRequestPromotion,
    requestPromotion,
    patch: patchOrgSettings,
    version: orgSettingsVersion,
  } = useOrgSettings(
    project?.orgId ?? projectOrg?.id,
    projectOrg?.role?.level ?? null,
    roleLevel ?? project?.syncRole?.level ?? null,
  )

  const { rules, userRules, builtinRules, addRule, updateRule, deleteRule, setBuiltinOverride } = useRules(
    project ?? null,
    refresh,
    patchSettings as Parameters<typeof useRules>[2],
    orgRules,
  )

  const jwt = session?.jwt
  const projectFiles = useMemo(
    () => (project?.files ?? []).map((file) => ({ id: file.id, name: file.name, type: file.type })),
    [project?.files],
  )
  const getToken = useCallback((fileId: string): Promise<string | null> => {
    if (!jwt) return Promise.resolve(null)
    return buildFileScopedTokenFetcher(() => jwt, projectId)(fileId)
  }, [jwt, projectId])

  const { files } = useProjectCells({
    projectId,
    projectFiles,
    getToken,
    enabled: Boolean(jwt) && Boolean(project),
  })

  const cells = useMemo(() => files.flatMap((file) => file.cells), [files])

  const enabledRules = useMemo(() => rules.filter((rule) => rule.enabled), [rules])
  const infractions = useMemo(() => {
    const out = new Map<string, RuleInfraction[]>()
    if (enabledRules.length === 0 || cells.length === 0) return out
    for (const cell of cells) {
      const cellInf = checkRulesForCell(cell, cell.fileId, enabledRules)
      if (cellInf.length > 0) out.set(cell.id, cellInf)
    }
    return out
  }, [cells, enabledRules])

  if (loading || !project) {
    return <LoadingPanel label="Loading rules" />
  }

  return (
    <RulesSurface
      embedded
      project={project}
      projectId={projectId}
      userRules={userRules}
      builtinRules={builtinRules}
      addRule={addRule}
      updateRule={updateRule}
      deleteRule={deleteRule}
      setBuiltinOverride={setBuiltinOverride}
      infractions={infractions}
      cells={cells}
      completionSettings={project.completionSettings}
      orgRules={orgRules}
      canEditOrgRules={canEditOrgSettings}
      patchOrgSettings={patchOrgSettings}
      orgSettingsVersion={orgSettingsVersion}
      promotionRequests={promotionRequests}
      canRequestPromotion={canRequestPromotion}
      requestPromotion={requestPromotion}
      editingRuleId={editingRuleId}
      setEditingRuleId={setEditingRuleId}
    />
  )
}
