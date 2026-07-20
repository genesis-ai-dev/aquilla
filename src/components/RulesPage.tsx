import { useEffect, useState, useMemo } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router-dom"
import { ArrowLeft, AlertTriangle, AlertCircle, Trash2, Wand2, ChevronDown, ChevronUp, BookOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { AppTooltip } from "@/components/ui/tooltip"
import { getProject } from "@/lib/store/project-index"
import { useRules } from "@/hooks/useRules"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { useLivingMemory } from "@/hooks/useLivingMemory"
import { RuleCreateDialog } from "./RuleCreateDialog"
import { RuleSuggestDialog } from "./RuleSuggestDialog"
import { BuiltinChecksList } from "./BuiltinChecksList"
import { FixReviewPanel } from "./FixReviewPanel"
import { ConfirmActionDialog } from "./ConfirmActionDialog"
import type { FixProposal } from "@/lib/rules/autofix"
import { ROLE } from "@/lib/sync/role-policy"
import type { ProjectRecord, RuleAutofix, TranslationRule } from "@/lib/parsers/types"
import { checkRulesForCell } from "@/lib/rules/rule-engine"

export function RulesPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null)

  function refresh() {
    if (!id) return
    getProject(id).then((p) => { if (p) setProject(p) })
  }

  useEffect(() => {
    if (!id) return
    getProject(id).then((p) => {
      if (p) setProject(p)
      setLoading(false)
    })
  }, [id])

  useEffect(() => {
    const focusId = searchParams.get("ruleId")
    const focus = searchParams.get("focus")
    if (focusId && focus === "autofix" && project) {
      setExpandedRuleId(focusId)
      requestAnimationFrame(() => {
        document.getElementById(`rule-row-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
      })
    }
  }, [searchParams, project])

  const { patch: patchShared, settings: projectWideSettings } = useProjectSettings(id ?? null, project?.syncRole?.level ?? null)
  const { userRules, builtinRules, addRule, updateRule, deleteRule, setBuiltinOverride } = useRules(project, refresh, patchShared)
  const { cells: validatedCells } = useLivingMemory({ projectId: id ?? "" })

  // AQU-291: pending delete confirmation state.
  const [pendingDeleteRuleId, setPendingDeleteRuleId] = useState<string | null>(null)
  const pendingDeleteRule = pendingDeleteRuleId ? userRules.find((r) => r.id === pendingDeleteRuleId) ?? null : null

  // AQU-186: harmonize sweep panel state.
  const [harmonizeRule, setHarmonizeRule] = useState<TranslationRule | null>(null)
  const [harmonizeProposal, setHarmonizeProposal] = useState<FixProposal | null>(null)

  // Derive harmonize_min_role gate from project settings and current role.
  const harmonizeMinRole = projectWideSettings.harmonize_min_role
  const userRoleLevel = project?.syncRole?.level ?? null

  // AQU-480: adding/editing/deleting rules and toggling built-in checks all
  // persist to project_settings, which the server gates at MAINTAINER (600) —
  // the same floor as useProjectSettings' EDIT_ROLE_FLOOR. Below that, every
  // write path (addRule/updateRule/deleteRule/setBuiltinOverride → patchShared)
  // gets a swallowed 403, so the change appears to save then vanishes on reload.
  // Gate the rule-management UI on that floor. Fail OPEN when the role is unknown
  // (local/unsynced project — IDB is authoritative and the write genuinely
  // persists), matching the harmonize gate below and the hook's null-role path.
  const canManageRules = userRoleLevel == null || userRoleLevel >= ROLE.MAINTAINER
  const manageRulesDeniedReason = canManageRules
    ? null
    : "Only maintainers and owners can add or change translation rules."

  const userCanHarmonize = useMemo(() => {
    if (userRoleLevel == null) return true // fail-open; server authoritative
    const FLOOR_MAP: Record<string, number> = {
      project_lead: ROLE.PROJECT_LEAD,
      maintainer: ROLE.MAINTAINER,
    }
    const floor = FLOOR_MAP[harmonizeMinRole ?? "project_lead"] ?? ROLE.PROJECT_LEAD
    return userRoleLevel >= floor
  }, [userRoleLevel, harmonizeMinRole])

  function handleHarmonize(rule: TranslationRule, _violationCount: number) {
    // Build a stub proposal. In v1, if the rule has a regex autofix, the
    // proposal is a regex-replace with empty previews (the worker hasn't run
    // the actual sweep yet — the FixReviewPanel will show 0 previews ready;
    // real sweep population via worker dispatch is a follow-on task).
    // For now, use a "none" proposal if there is no autofix, directing the
    // user to add one.
    if (rule.autofix) {
      const proposal: FixProposal = {
        kind: "regex-replace",
        pattern: rule.autofix.pattern,
        replacement: rule.autofix.replacement,
        flags: rule.autofix.flags,
        previews: [],
      }
      setHarmonizeProposal(proposal)
    } else {
      setHarmonizeProposal({ kind: "none", reason: "This check has no auto-fix defined. Add one in the Rules section below, then retry." })
    }
    setHarmonizeRule(rule)
  }

  function handleHarmonizeApply(_selectedCellIds: Set<string>) {
    // SWARM-TODO: wire to emitCellHarmonize per cell once the sweep-population
    // worker path is implemented. For now just close the panel.
    // Click-path: Rules → builtin-check row → "Harmonize all (N)" → FixReviewPanel
    //   → type rule name → Apply N selected → here.
    setHarmonizeRule(null)
    setHarmonizeProposal(null)
  }

  // AQU-186: derive per-cell infractions for builtin checks over the project
  // scope (all validated cells from useLivingMemory, up to MAX_FILES=40 files).
  // Scope rationale: FixReviewPanel's multi-cell harmonize sweep targets the
  // whole project, so infraction counts must be project-wide.
  // Performance: O(cells × builtinRules). builtinRules is ≤9; validatedCells
  // is bounded to the first 40 files. checkRulesForCell is pure and fast
  // (regex cache prevents recompilation). The memo only re-runs when cells or
  // rules change — not on every render.
  const enabledBuiltinRules = useMemo(
    () => builtinRules.filter((r) => r.enabled),
    [builtinRules],
  )
  const builtinInfractions = useMemo(() => {
    const out = new Map<string, import("@/lib/parsers/types").RuleInfraction[]>()
    if (enabledBuiltinRules.length === 0 || validatedCells.length === 0) return out
    for (const cell of validatedCells) {
      const cellInf = checkRulesForCell(cell, cell.fileId, enabledBuiltinRules)
      if (cellInf.length > 0) out.set(cell.id, cellInf)
    }
    return out
  }, [validatedCells, enabledBuiltinRules])

  const usageSummary = useMemo(() => {
    const u = project?.usage
    if (!u) return null
    const calls = Object.values(u.llmCalls).reduce((s, v) => s + v.total, 0)
    return `${u.fixesApplied} fixes applied · ${calls} LLM calls this project`
  }, [project?.usage])

  if (loading) return <div className="p-8 text-muted-foreground">Loading...</div>

  function toggleExpanded(ruleId: string) {
    setExpandedRuleId((cur) => cur === ruleId ? null : ruleId)
    const next = new URLSearchParams(searchParams)
    if (next.get("ruleId") === ruleId) next.delete("ruleId"); else next.set("ruleId", ruleId)
    next.delete("focus")
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="min-h-screen bg-background">
      {/* AQU-186: Harmonize sweep panel (multi-cell FixReviewPanel). */}
      {harmonizeRule && harmonizeProposal && (
        <FixReviewPanel
          open={true}
          rule={harmonizeRule}
          proposal={harmonizeProposal}
          onClose={() => { setHarmonizeRule(null); setHarmonizeProposal(null) }}
          onApply={handleHarmonizeApply}
          onAmendRule={() => {
            setHarmonizeRule(null)
            setHarmonizeProposal(null)
            // Navigate to the rule row so the user can add an autofix.
            if (harmonizeRule) {
              setExpandedRuleId(harmonizeRule.id)
              requestAnimationFrame(() => {
                document.getElementById(`rule-row-${harmonizeRule.id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" })
              })
            }
          }}
          confirmPhrase={harmonizeRule.name}
        />
      )}
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}/editor`)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Editor
        </Button>
        <h2 className="font-semibold">Translation Rules</h2>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => navigate(`/project/${id}/terminology`)}>
          <BookOpen className="mr-1 h-3.5 w-3.5" />
          Terminology
        </Button>
        <RuleSuggestDialog files={project?.files || []} completionSettings={project?.completionSettings} onAdd={addRule} projectId={id} cells={validatedCells} canManage={canManageRules} deniedReason={manageRulesDeniedReason} />
        <RuleCreateDialog onAdd={addRule} canManage={canManageRules} deniedReason={manageRulesDeniedReason} />
      </header>

      <main className="mx-auto max-w-2xl space-y-6 p-6">
        {usageSummary && (
          <AppTooltip content="LLM usage on this project">
            <p className="text-xs text-muted-foreground">{usageSummary}</p>
          </AppTooltip>
        )}

        {/* AQU-480: contributors could add/edit rules that silently 403'd and
            vanished on reload. Surface a visible read-only reason instead. */}
        {!canManageRules && (
          <div
            role="status"
            className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          >
            {manageRulesDeniedReason} Changes made here won't be saved.
          </div>
        )}

        <BuiltinChecksList
          builtinRules={builtinRules}
          infractions={builtinInfractions}
          onSetOverride={setBuiltinOverride}
          onHarmonize={handleHarmonize}
          canHarmonize={userCanHarmonize}
          canManage={canManageRules}
        />

        <Card>
          <CardHeader><CardTitle>Rules ({userRules.length})</CardTitle></CardHeader>
          <CardContent>
            {userRules.length === 0 ? (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>No rules defined yet.</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {userRules.map((rule) => {
                  const Icon = rule.severity === "major" ? AlertTriangle : AlertCircle
                  const badgeColor = rule.severity === "major"
                    ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                  const expanded = expandedRuleId === rule.id
                  return (
                    <li key={rule.id} id={`rule-row-${rule.id}`} className="rounded border p-3">
                      <div className="flex items-center gap-3">
                        <Icon className={`h-4 w-4 flex-shrink-0 ${rule.severity === "major" ? "text-red-500" : "text-amber-500"}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{rule.name}</span>
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeColor}`}>{rule.severity}</span>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{rule.source}</span>
                            {rule.autofix && <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300">autofix</span>}
                          </div>
                          {rule.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{rule.description}</p>}
                        </div>
                        <AppTooltip content="Opens the editor with this rule's drawer">
                          <Button size="sm" variant="outline" onClick={() => navigate(`/project/${id}/editor?openRule=${rule.id}`)}>
                            <Wand2 className="mr-1 h-3.5 w-3.5" />
                            Try to fix all
                          </Button>
                        </AppTooltip>
                        <Button variant="ghost" size="sm" onClick={() => toggleExpanded(rule.id)}>
                          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </Button>
                        <label className="flex items-center gap-1 text-xs">
                          <Switch size="sm" checked={rule.enabled}
                            disabled={!canManageRules}
                            onCheckedChange={(checked) => updateRule(rule.id, { enabled: checked })} />
                          <span className="text-muted-foreground">Enabled</span>
                        </label>
                        <AppTooltip content={manageRulesDeniedReason ?? undefined} disabled={canManageRules || !manageRulesDeniedReason}>
                          <Button variant="ghost" size="sm" aria-label={`Delete rule ${rule.name}`}
                            disabled={!canManageRules}
                            onClick={() => setPendingDeleteRuleId(rule.id)}>
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </AppTooltip>
                      </div>

                      {expanded && (
                        <AutofixEditor rule={rule} onUpdate={(af) => updateRule(rule.id, { autofix: af })} disabled={!canManageRules} />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>

      {/* AQU-291: checkbox-confirm before deleting a rule */}
      <ConfirmActionDialog
        open={pendingDeleteRuleId !== null}
        onOpenChange={(v) => { if (!v) setPendingDeleteRuleId(null) }}
        title="Delete rule"
        description={
          pendingDeleteRule
            ? `Delete "${pendingDeleteRule.name}"? This removes the rule for everyone in the project and cannot be undone.`
            : "Delete this rule? This removes it for everyone in the project and cannot be undone."
        }
        confirmLabel="Delete rule"
        checkboxLabel="I understand this deletes the rule for everyone in the project."
        variant="destructive"
        onConfirm={() => { if (pendingDeleteRuleId) deleteRule(pendingDeleteRuleId) }}
      />
    </div>
  )
}

function AutofixEditor({ rule, onUpdate, disabled = false }: { rule: TranslationRule; onUpdate: (af: RuleAutofix | undefined) => void; disabled?: boolean }) {
  const [pattern, setPattern] = useState(rule.autofix?.pattern ?? "")
  const [replacement, setReplacement] = useState(rule.autofix?.replacement ?? "")
  const [flags, setFlags] = useState(rule.autofix?.flags ?? "gi")

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <p className="text-xs text-muted-foreground">Saved autofix (regex)</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input data-autofix-field="pattern" placeholder="Pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} disabled={disabled} />
        <Input placeholder="Replacement" value={replacement} onChange={(e) => setReplacement(e.target.value)} disabled={disabled} />
        <Input placeholder="Flags (e.g. gi)" value={flags} onChange={(e) => setFlags(e.target.value)} disabled={disabled} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={disabled} onClick={() => onUpdate(pattern ? { kind: "regex-replace", pattern, replacement, flags } : undefined)}>
          Save autofix
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onUpdate(undefined)}>Clear</Button>
      </div>
    </div>
  )
}
