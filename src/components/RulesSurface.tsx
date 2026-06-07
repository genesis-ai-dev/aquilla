/**
 * RulesSurface — in-shell Rules view for FRO-194.
 *
 * Renders INSIDE the ProjectWorkspace AppShell as the `main` content area.
 * The shell (sidebar, top bar, status bar) stays mounted at all times;
 * only this component swaps in place of the EditorTable.
 */
import { useState, useMemo, useEffect } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { AlertTriangle, AlertCircle, Trash2, Wand2, ChevronDown, ChevronUp, BookOpen, Pencil, ArrowUpCircle, Building2, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { BuiltinChecksList } from "./BuiltinChecksList"
import { RuleSuggestDialog } from "./RuleSuggestDialog"
import { RuleSuggestFromEditsDialog } from "./RuleSuggestFromEditsDialog"
import { RuleEditor } from "./RuleEditor"
import { RuleImportDialog } from "./RuleImportDialog"
import type { ProjectRecord, RuleAutofix, TranslationRule } from "@/lib/parsers/types"
import type { useRules } from "@/hooks/useRules"
import type { CellData } from "@/hooks/useCells"
import type { OrgWideSettings, OrgPatchResult } from "@/lib/sync/org-settings"
import { v4 as uuid } from "uuid"

// SWARM-TODO(FRO-195/196/198): replace RuleCreateDialog + RuleSuggestDialog
// with inline inline surface editors when those tickets land.

type UseRulesReturn = ReturnType<typeof useRules>

interface Props {
  project: ProjectRecord
  projectId: string
  userRules: UseRulesReturn["userRules"]
  builtinRules: UseRulesReturn["builtinRules"]
  addRule: UseRulesReturn["addRule"]
  updateRule: UseRulesReturn["updateRule"]
  deleteRule: UseRulesReturn["deleteRule"]
  setBuiltinOverride: UseRulesReturn["setBuiltinOverride"]
  infractions: Map<string, import("@/lib/parsers/types").RuleInfraction[]>
  validatedCells: CellData[]
  /** Org-level rules (read from org settings). Empty when not in an org. */
  orgRules?: TranslationRule[]
  /** True when the caller has org MAINTAINER+ role and can edit org settings. */
  canEditOrgRules?: boolean
  /** Patch function for org settings (from useOrgSettings). */
  patchOrgSettings?: (partial: OrgWideSettings) => Promise<OrgPatchResult | { kind: "blocked" }>
  /** Current org settings version (needed for conflict-free patching). */
  orgSettingsVersion?: number | null
}

export function RulesSurface({
  project,
  projectId,
  userRules,
  builtinRules,
  addRule,
  updateRule,
  deleteRule,
  setBuiltinOverride,
  infractions,
  validatedCells,
  orgRules = [],
  canEditOrgRules = false,
  patchOrgSettings,
}: Props) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null)
  // FRO-195: inline create/edit state — null = closed, "new" = create, ruleId = edit
  const [editingRuleId, setEditingRuleId] = useState<string | "new" | null>(null)
  // Promote-to-org confirmation dialog state.
  const [promoteRule, setPromoteRule] = useState<TranslationRule | null>(null)
  const [promoting, setPromoting] = useState(false)
  // Inline edit state for org rules (maintainer only).
  const [editingOrgRuleId, setEditingOrgRuleId] = useState<string | "new" | null>(null)

  // Focus a rule row when arriving via deep-link with ?ruleId=&focus=autofix
  useEffect(() => {
    const focusId = searchParams.get("ruleId")
    const focus = searchParams.get("focus")
    if (focusId && focus === "autofix") {
      setExpandedRuleId(focusId)
      requestAnimationFrame(() => {
        document.getElementById(`rule-row-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
      })
    }
  }, [searchParams])

  const usageSummary = useMemo(() => {
    const u = project?.usage
    if (!u) return null
    const calls = Object.values(u.llmCalls).reduce((s, v) => s + v.total, 0)
    return `${u.fixesApplied} fixes applied · ${calls} LLM calls this project`
  }, [project?.usage])

  /** Copy a project rule into the org settings (maintainer only). */
  async function handlePromoteToOrg(rule: TranslationRule) {
    if (!patchOrgSettings) return
    setPromoting(true)
    const promoted: TranslationRule = {
      ...rule,
      id: uuid(),
      scope: "org",
      sourceProjectId: projectId,
      createdAt: new Date().toISOString(),
    }
    const newOrgRules = [...orgRules, promoted]
    await patchOrgSettings({ rules: newOrgRules })
    setPromoting(false)
    setPromoteRule(null)
  }

  /** Update a single org rule (maintainer only). */
  async function updateOrgRule(ruleId: string, updates: Partial<TranslationRule>) {
    if (!patchOrgSettings) return
    const updated = orgRules.map((r) => r.id === ruleId ? { ...r, ...updates } : r)
    await patchOrgSettings({ rules: updated })
  }

  /** Delete a single org rule (maintainer only). */
  async function deleteOrgRule(ruleId: string) {
    if (!patchOrgSettings) return
    const updated = orgRules.filter((r) => r.id !== ruleId)
    await patchOrgSettings({ rules: updated })
  }

  /** Add a new org rule directly (maintainer only). */
  async function addOrgRule(rule: Omit<TranslationRule, "id" | "createdAt">) {
    if (!patchOrgSettings) return
    const newRule: TranslationRule = { ...rule, id: uuid(), scope: "org", createdAt: new Date().toISOString() }
    await patchOrgSettings({ rules: [...orgRules, newRule] })
  }

  function toggleExpanded(ruleId: string) {
    setExpandedRuleId((cur) => cur === ruleId ? null : ruleId)
    const next = new URLSearchParams(searchParams)
    if (next.get("ruleId") === ruleId) next.delete("ruleId"); else next.set("ruleId", ruleId)
    next.delete("focus")
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        {/* Action toolbar */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`/project/${projectId}/terminology`)}>
            <BookOpen className="mr-1 h-3.5 w-3.5" />
            Terminology
          </Button>
          <div className="flex-1" />
          {/* SWARM-TODO(FRO-196): RuleImportDialog — bulk import via document drop/paste */}
          <RuleImportDialog
            completionSettings={project?.completionSettings}
            onAdd={addRule}
            projectId={projectId}
          />
          {/* FRO-198: suggest rules from mined edits — repeated corrections + recent edits + validated pairs */}
          {/* SWARM-TODO(FRO-198-cells): RulesSurface only receives `validatedCells`; for richer
              repeated-edit detection, ProjectWorkspace should also pass ALL cells (including
              unvalidated) so hasPendingEdit recent-edits and cross-status patterns are visible.
              Until then, mining runs on validatedCells only. */}
          <RuleSuggestFromEditsDialog
            completionSettings={project?.completionSettings}
            onAdd={addRule}
            projectId={projectId}
            cells={validatedCells}
          />
          {/* Legacy suggest from pairs (kept for backward compat; may be removed in FRO-199) */}
          <RuleSuggestDialog
            files={project?.files || []}
            completionSettings={project?.completionSettings}
            onAdd={addRule}
            projectId={projectId}
            cells={validatedCells}
          />
          {/* FRO-195: inline create surface replaces the dialog */}
          <Button
            size="sm"
            onClick={() => setEditingRuleId("new")}
            disabled={editingRuleId !== null}
          >
            + Add Rule
          </Button>
        </div>

        {/* FRO-195: inline rule editor (create mode) */}
        {editingRuleId === "new" && (
          <RuleEditor
            cells={validatedCells}
            onSave={async (rule) => {
              await addRule(rule)
              setEditingRuleId(null)
            }}
            onCancel={() => setEditingRuleId(null)}
          />
        )}

        {usageSummary && (
          <p className="text-xs text-muted-foreground" title="LLM usage on this project">{usageSummary}</p>
        )}

        {/* TODO(lqa-plan-b): wire real infractions when worker dispatch lands. */}
        <BuiltinChecksList
          builtinRules={builtinRules}
          infractions={infractions}
          onSetOverride={setBuiltinOverride}
        />

        {/* ── Org rules section ── */}
        {(orgRules.length > 0 || canEditOrgRules) && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <CardTitle>Org Rules ({orgRules.length})</CardTitle>
                {canEditOrgRules && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    onClick={() => setEditingOrgRuleId("new")}
                    disabled={editingOrgRuleId !== null}
                  >
                    + Add Org Rule
                  </Button>
                )}
                {!canEditOrgRules && (
                  <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" />
                    Read-only
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {editingOrgRuleId === "new" && canEditOrgRules && (
                <div className="mb-4">
                  <RuleEditor
                    cells={validatedCells}
                    onSave={async (rule) => {
                      await addOrgRule(rule)
                      setEditingOrgRuleId(null)
                    }}
                    onCancel={() => setEditingOrgRuleId(null)}
                  />
                </div>
              )}
              {orgRules.length === 0 ? (
                <p className="text-sm text-muted-foreground">No org-level rules yet. Add one or promote a project rule.</p>
              ) : (
                <ul className="space-y-2">
                  {orgRules.map((rule) => {
                    const Icon = rule.severity === "major" ? AlertTriangle : AlertCircle
                    const badgeColor = rule.severity === "major"
                      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                    return (
                      <li key={rule.id} className="rounded border p-3">
                        <div className="flex items-center gap-3">
                          <Icon className={`h-4 w-4 flex-shrink-0 ${rule.severity === "major" ? "text-red-500" : "text-amber-500"}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{rule.name}</span>
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeColor}`}>{rule.severity}</span>
                              <span className="rounded bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 px-1.5 py-0.5 text-[10px] font-medium">Org</span>
                            </div>
                            {rule.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{rule.description}</p>}
                          </div>
                          {canEditOrgRules && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingOrgRuleId(editingOrgRuleId === rule.id ? null : rule.id)}
                                title="Edit org rule"
                                disabled={editingOrgRuleId !== null && editingOrgRuleId !== rule.id}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <label className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={rule.enabled}
                                  onChange={(e) => updateOrgRule(rule.id, { enabled: e.target.checked })}
                                />
                                <span className="text-muted-foreground">Enabled</span>
                              </label>
                              <Button variant="ghost" size="sm" onClick={() => deleteOrgRule(rule.id)}>
                                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                              </Button>
                            </>
                          )}
                        </div>
                        {editingOrgRuleId === rule.id && canEditOrgRules && (
                          <div className="mt-3 border-t pt-3">
                            <RuleEditor
                              initialRule={rule}
                              cells={validatedCells}
                              onSave={async (updates) => {
                                await updateOrgRule(rule.id, updates)
                                setEditingOrgRuleId(null)
                              }}
                              onCancel={() => setEditingOrgRuleId(null)}
                            />
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {/* Promote confirmation dialog */}
        {promoteRule && (
          <Dialog open onOpenChange={(open) => { if (!open) setPromoteRule(null) }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Promote rule to org?</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                A copy of <strong>{promoteRule.name}</strong> will be added to the org's rule library. The project copy is kept.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPromoteRule(null)}>Cancel</Button>
                <Button onClick={() => handlePromoteToOrg(promoteRule)} disabled={promoting}>
                  {promoting ? "Promoting…" : "Promote to org"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        <Card>
          <CardHeader><CardTitle>Project Rules ({userRules.length})</CardTitle></CardHeader>
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
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigate(`/project/${projectId}?openRule=${rule.id}`)}
                          title="Opens the editor with this rule's drawer"
                        >
                          <Wand2 className="mr-1 h-3.5 w-3.5" />
                          Try to fix all
                        </Button>
                        {/* Org promotion — maintainer sees Promote, project_lead sees disabled Request */}
                        {canEditOrgRules && patchOrgSettings && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPromoteRule(rule)}
                            title="Copy this rule to the org's rule library"
                          >
                            <ArrowUpCircle className="mr-1 h-3.5 w-3.5" />
                            Promote to org
                          </Button>
                        )}
                        {!canEditOrgRules && orgRules !== undefined && (
                          // SWARM-TODO: implement full promotion request workflow (FRO-org-promote-request)
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled
                            title="Ask an org manager to promote this rule to org scope"
                          >
                            <ArrowUpCircle className="mr-1 h-3.5 w-3.5" />
                            Request promotion
                          </Button>
                        )}
                        {/* FRO-195: inline edit entry */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingRuleId(editingRuleId === rule.id ? null : rule.id)}
                          title="Edit rule"
                          disabled={editingRuleId !== null && editingRuleId !== rule.id}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => toggleExpanded(rule.id)}>
                          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </Button>
                        <label className="flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
                          />
                          <span className="text-muted-foreground">Enabled</span>
                        </label>
                        <Button variant="ghost" size="sm" onClick={() => deleteRule(rule.id)}>
                          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </div>

                      {expanded && (
                        <AutofixEditor rule={rule} onUpdate={(af) => updateRule(rule.id, { autofix: af })} />
                      )}
                      {/* FRO-195: inline edit form */}
                      {editingRuleId === rule.id && (
                        <div className="mt-3 border-t pt-3">
                          <RuleEditor
                            initialRule={rule}
                            cells={validatedCells}
                            onSave={async (updates) => {
                              await updateRule(rule.id, updates)
                              setEditingRuleId(null)
                            }}
                            onCancel={() => setEditingRuleId(null)}
                          />
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function AutofixEditor({ rule, onUpdate }: { rule: TranslationRule; onUpdate: (af: RuleAutofix | undefined) => void }) {
  const [pattern, setPattern] = useState(rule.autofix?.pattern ?? "")
  const [replacement, setReplacement] = useState(rule.autofix?.replacement ?? "")
  const [flags, setFlags] = useState(rule.autofix?.flags ?? "gi")

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Saved autofix (regex)</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input data-autofix-field="pattern" placeholder="Pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <Input placeholder="Replacement" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
        <Input placeholder="Flags (e.g. gi)" value={flags} onChange={(e) => setFlags(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onUpdate(pattern ? { kind: "regex-replace", pattern, replacement, flags } : undefined)}>
          Save autofix
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onUpdate(undefined)}>Clear</Button>
      </div>
    </div>
  )
}
