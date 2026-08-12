/**
 * RulesSurface — in-shell Rules view for AQU-194.
 *
 * Renders INSIDE the ProjectWorkspace AppShell as the `main` content area.
 * The shell (sidebar, top bar, status bar) stays mounted at all times;
 * only this component swaps in place of the EditorTable.
 */
import { useState, useMemo, useEffect } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { AlertTriangle, AlertCircle, Trash2, Wand2, ChevronDown, ChevronUp, Pencil, ArrowUpCircle, Building2, Lock, Clock, ScrollText, Plus, BookOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/page"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { AppTooltip } from "@/components/ui/tooltip"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { BuiltinChecksList } from "./BuiltinChecksList"
import { RuleEditor } from "./RuleEditor"
import { RuleImportDialog } from "./RuleImportDialog"
import { RuleSuggestFromEditsDialog } from "./RuleSuggestFromEditsDialog"
import { cn } from "@/lib/utils"
import type { CompletionSettings, ProjectRecord, RuleAutofix, TranslationRule, PromotionRequest } from "@/lib/parsers/types"
import type { useRules } from "@/hooks/useRules"
import type { CellData } from "@/hooks/useCells"
import type { OrgWideSettings, OrgPatchResult, PromotionRequestResult } from "@/lib/sync/org-settings"
import { v4 as uuid } from "uuid"

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
  cells: CellData[]
  completionSettings?: CompletionSettings
  orgRules?: TranslationRule[]
  canEditOrgRules?: boolean
  patchOrgSettings?: (partial: OrgWideSettings) => Promise<OrgPatchResult | { kind: "blocked" }>
  orgSettingsVersion?: number | null
  promotionRequests?: PromotionRequest[]
  canRequestPromotion?: boolean
  requestPromotion?: (rule: TranslationRule, sourceProjectId: string) => Promise<PromotionRequestResult | { kind: "blocked" }>
  editingRuleId: string | "new" | null
  setEditingRuleId: (id: string | "new" | null) => void
}

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge variant={severity === "major" ? "destructive" : "outline"}>
      {severity}
    </Badge>
  )
}

function SeverityIcon({ severity }: { severity: string }) {
  const Icon = severity === "major" ? AlertTriangle : AlertCircle
  return (
    <Icon className={cn(
      "size-4 shrink-0",
      severity === "major" ? "text-destructive" : "text-muted-foreground",
    )} />
  )
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
  cells,
  completionSettings,
  orgRules = [],
  canEditOrgRules = false,
  patchOrgSettings,
  promotionRequests = [],
  canRequestPromotion = false,
  requestPromotion,
  editingRuleId,
  setEditingRuleId,
}: Props) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null)
  const [promoteRule, setPromoteRule] = useState<TranslationRule | null>(null)
  const [promoting, setPromoting] = useState(false)
  const [editingOrgRuleId, setEditingOrgRuleId] = useState<string | "new" | null>(null)
  const [requestedRuleIds, setRequestedRuleIds] = useState<Set<string>>(new Set())
  const [requestingRuleId, setRequestingRuleId] = useState<string | null>(null)
  const [requestNotice, setRequestNotice] = useState<Map<string, string>>(new Map())

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

  async function handleRequestPromotion(rule: TranslationRule) {
    if (!requestPromotion) return
    setRequestingRuleId(rule.id)
    const result = await requestPromotion(rule, projectId)
    setRequestingRuleId(null)
    if (result.kind === "ok") {
      setRequestedRuleIds((prev) => new Set([...prev, rule.id]))
      setRequestNotice((prev) => new Map(prev).set(rule.id, "Requested ✓"))
    } else if (result.kind === "duplicate") {
      setRequestedRuleIds((prev) => new Set([...prev, rule.id]))
      setRequestNotice((prev) => new Map(prev).set(rule.id, "Already requested"))
    } else {
      setRequestNotice((prev) => new Map(prev).set(rule.id, "Failed — try again"))
    }
  }

  async function updateOrgRule(ruleId: string, updates: Partial<TranslationRule>) {
    if (!patchOrgSettings) return
    const updated = orgRules.map((r) => r.id === ruleId ? { ...r, ...updates } : r)
    await patchOrgSettings({ rules: updated })
  }

  async function deleteOrgRule(ruleId: string) {
    if (!patchOrgSettings) return
    const updated = orgRules.filter((r) => r.id !== ruleId)
    await patchOrgSettings({ rules: updated })
  }

  async function addOrgRule(rule: Omit<TranslationRule, "id" | "createdAt">) {
    if (!patchOrgSettings) return
    const newRule: TranslationRule = { ...rule, id: uuid(), scope: "org", createdAt: new Date().toISOString() }
    await patchOrgSettings({ rules: [...orgRules, newRule] })
  }

  async function handleApproveRequest(req: PromotionRequest) {
    if (!patchOrgSettings) return
    const promoted: TranslationRule = {
      ...req.rule,
      id: uuid(),
      scope: "org",
      sourceProjectId: req.sourceProjectId,
      createdAt: new Date().toISOString(),
    }
    const newOrgRules = [...orgRules, promoted]
    const newPendingRequests = promotionRequests.filter((r) => r.id !== req.id)
    await patchOrgSettings({ rules: newOrgRules, promotionRequests: newPendingRequests })
  }

  async function handleDismissRequest(reqId: string) {
    if (!patchOrgSettings) return
    const newPendingRequests = promotionRequests.filter((r) => r.id !== reqId)
    await patchOrgSettings({ promotionRequests: newPendingRequests })
  }

  function toggleExpanded(ruleId: string) {
    setExpandedRuleId((cur) => cur === ruleId ? null : ruleId)
    const next = new URLSearchParams(searchParams)
    if (next.get("ruleId") === ruleId) next.delete("ruleId"); else next.set("ruleId", ruleId)
    next.delete("focus")
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* In-main toolbar — matches Glossary/Terminology: actions live in the
          surface, not the workspace header. */}
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <ScrollText className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h1 className="flex-1 text-base font-semibold">Rules</h1>
        <Button variant="outline" size="sm" onClick={() => navigate(`/project/${projectId}/terminology`)}>
          <BookOpen data-icon="inline-start" />
          Terminology
        </Button>
        <RuleImportDialog
          completionSettings={completionSettings}
          onAdd={addRule}
          projectId={projectId}
        />
        <RuleSuggestFromEditsDialog
          completionSettings={completionSettings}
          onAdd={addRule}
          projectId={projectId}
          cells={cells}
        />
        <Button
          size="sm"
          onClick={() => setEditingRuleId("new")}
          disabled={editingRuleId !== null}
        >
          <Plus className="size-4" aria-hidden />
          Add Rule
        </Button>
      </header>

      {/* Create project rule — dialog, not inline */}
      <Dialog
        open={editingRuleId === "new"}
        onOpenChange={(open) => { if (!open) setEditingRuleId(null) }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[90vh] max-w-2xl gap-0 overflow-y-auto p-0 sm:max-w-2xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Create translation rule</DialogTitle>
            <DialogDescription>Create a project translation rule.</DialogDescription>
          </DialogHeader>
          <RuleEditor
            className="rounded-none border-0"
            cells={cells}
            onSave={async (rule) => {
              await addRule(rule)
              setEditingRuleId(null)
            }}
            onCancel={() => setEditingRuleId(null)}
          />
        </DialogContent>
      </Dialog>

      {/* Create org rule — dialog, not inline */}
      <Dialog
        open={editingOrgRuleId === "new"}
        onOpenChange={(open) => { if (!open) setEditingOrgRuleId(null) }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[90vh] max-w-2xl gap-0 overflow-y-auto p-0 sm:max-w-2xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Create org rule</DialogTitle>
            <DialogDescription>Create an org-scoped translation rule.</DialogDescription>
          </DialogHeader>
          <RuleEditor
            className="rounded-none border-0"
            cells={cells}
            onSave={async (rule) => {
              await addOrgRule(rule)
              setEditingOrgRuleId(null)
            }}
            onCancel={() => setEditingOrgRuleId(null)}
          />
        </DialogContent>
      </Dialog>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
        {usageSummary && (
          <AppTooltip content="LLM usage on this project">
            <p className="text-xs text-muted-foreground">{usageSummary}</p>
          </AppTooltip>
        )}

        <BuiltinChecksList
          builtinRules={builtinRules}
          infractions={infractions}
          onSetOverride={setBuiltinOverride}
        />

        {/* Org rules */}
        {(orgRules.length > 0 || canEditOrgRules) && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Building2 className="size-4 text-muted-foreground" />
                <CardTitle>Org Rules ({orgRules.length})</CardTitle>
                {canEditOrgRules && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ms-auto"
                    onClick={() => setEditingOrgRuleId("new")}
                    disabled={editingOrgRuleId !== null}
                  >
                    <Plus className="size-4" aria-hidden />
                    Add Org Rule
                  </Button>
                )}
                {!canEditOrgRules && (
                  <Badge variant="secondary" className="ms-auto">
                    <Lock data-icon="inline-start" />
                    Read-only
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {orgRules.length === 0 ? (
                <EmptyState
                  variant="inline"
                  className="px-0 py-4"
                  icon={Building2}
                  title="No org-level rules yet"
                  description="Add one or promote a project rule."
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {orgRules.map((rule) => (
                    <li key={rule.id} className="rounded-md border p-3">
                      <div className="flex items-center gap-3">
                        <SeverityIcon severity={rule.severity} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{rule.name}</span>
                            <SeverityBadge severity={rule.severity} />
                            <Badge>Org</Badge>
                          </div>
                          {rule.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{rule.description}</p>}
                        </div>
                        {canEditOrgRules && (
                          <>
                            <AppTooltip content="Edit org rule">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingOrgRuleId(editingOrgRuleId === rule.id ? null : rule.id)}
                                disabled={editingOrgRuleId !== null && editingOrgRuleId !== rule.id}
                                aria-label="Edit org rule"
                              >
                                <Pencil />
                              </Button>
                            </AppTooltip>
                            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Switch
                                size="sm"
                                checked={rule.enabled}
                                onCheckedChange={(checked) => updateOrgRule(rule.id, { enabled: checked })}
                                aria-label={`${rule.enabled ? "Disable" : "Enable"} org rule: ${rule.name}`}
                              />
                              Enabled
                            </label>
                            <Button variant="ghost" size="sm" onClick={() => deleteOrgRule(rule.id)}>
                              <Trash2 />
                            </Button>
                          </>
                        )}
                      </div>
                      {editingOrgRuleId === rule.id && canEditOrgRules && (
                        <>
                          <Separator className="my-3" />
                          <RuleEditor
                            initialRule={rule}
                            cells={cells}
                            onSave={async (updates) => {
                              await updateOrgRule(rule.id, updates)
                              setEditingOrgRuleId(null)
                            }}
                            onCancel={() => setEditingOrgRuleId(null)}
                          />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {canEditOrgRules && promotionRequests.length > 0 && (
                <>
                  <Separator className="my-4" />
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Clock className="size-3.5" />
                    Pending requests ({promotionRequests.length})
                  </p>
                  <ul className="flex flex-col gap-2">
                    {promotionRequests.map((req) => (
                      <li key={req.id} className="rounded-md border bg-muted/30 p-3">
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">{req.rule.name}</p>
                            {req.rule.description && (
                              <p className="mt-0.5 text-xs text-muted-foreground truncate">{req.rule.description}</p>
                            )}
                            <p className="mt-1 text-xs text-muted-foreground">
                              Requested by {req.requestedByName ?? `user ${req.requestedBy}`}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <AppTooltip content="Promote this rule to org scope">
                              <Button size="sm" onClick={() => handleApproveRequest(req)}>
                                Approve
                              </Button>
                            </AppTooltip>
                            <AppTooltip content="Dismiss this request">
                              <Button size="sm" variant="ghost" onClick={() => handleDismissRequest(req.id)}>
                                Dismiss
                              </Button>
                            </AppTooltip>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
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
              <EmptyState
                variant="inline"
                className="px-0 py-4"
                icon={ScrollText}
                title="No project rules yet"
                description={
                  <>
                    Add a rule, import a style guide, or suggest rules from your edits using the buttons above.
                    {canEditOrgRules && orgRules.length > 0 && " Org rules above also apply to this project."}
                  </>
                }
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {userRules.map((rule) => {
                  const expanded = expandedRuleId === rule.id
                  return (
                    <li key={rule.id} id={`rule-row-${rule.id}`} className="rounded-md border p-3">
                      <div className="flex items-center gap-3">
                        <SeverityIcon severity={rule.severity} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium">{rule.name}</span>
                            <SeverityBadge severity={rule.severity} />
                            <Badge variant="secondary">{rule.source}</Badge>
                            {rule.autofix && <Badge variant="outline">autofix</Badge>}
                          </div>
                          {rule.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{rule.description}</p>}
                        </div>
                        <AppTooltip content="Opens the editor with this rule's drawer">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => navigate(`/project/${projectId}/editor?openRule=${rule.id}`)}
                          >
                            <Wand2 data-icon="inline-start" />
                            Try to fix all
                          </Button>
                        </AppTooltip>
                        {canEditOrgRules && patchOrgSettings && (
                          <AppTooltip content="Copy this rule to the org's rule library">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPromoteRule(rule)}
                          >
                            <ArrowUpCircle data-icon="inline-start" />
                            Promote to org
                          </Button>
                          </AppTooltip>
                        )}
                        {!canEditOrgRules && canRequestPromotion && requestPromotion && (
                          (() => {
                            const alreadyRequested = requestedRuleIds.has(rule.id) ||
                              promotionRequests.some((r) => r.rule.id === rule.id && r.sourceProjectId === projectId)
                            const notice = requestNotice.get(rule.id)
                            const isRequesting = requestingRuleId === rule.id
                            return alreadyRequested || notice ? (
                              <Badge variant="secondary">
                                <Clock data-icon="inline-start" />
                                {notice ?? "Requested"}
                              </Badge>
                            ) : (
                              <AppTooltip content="Ask an org maintainer to promote this rule to org scope">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleRequestPromotion(rule)}
                                  disabled={isRequesting}
                                >
                                  <ArrowUpCircle data-icon="inline-start" />
                                  {isRequesting ? "Requesting…" : "Request promotion"}
                                </Button>
                              </AppTooltip>
                            )
                          })()
                        )}
                        <AppTooltip content="Edit rule">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingRuleId(editingRuleId === rule.id ? null : rule.id)}
                            disabled={editingRuleId !== null && editingRuleId !== rule.id}
                            aria-label="Edit rule"
                          >
                            <Pencil />
                          </Button>
                        </AppTooltip>
                        <Button variant="ghost" size="sm" onClick={() => toggleExpanded(rule.id)}>
                          {expanded ? <ChevronUp /> : <ChevronDown />}
                        </Button>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Switch
                            size="sm"
                            checked={rule.enabled}
                            onCheckedChange={(checked) => updateRule(rule.id, { enabled: checked })}
                            aria-label={`${rule.enabled ? "Disable" : "Enable"} rule: ${rule.name}`}
                          />
                          Enabled
                        </label>
                        <Button variant="ghost" size="sm" onClick={() => deleteRule(rule.id)}>
                          <Trash2 />
                        </Button>
                      </div>

                      {expanded && (
                        <AutofixEditor rule={rule} onUpdate={(af) => updateRule(rule.id, { autofix: af })} />
                      )}
                      {editingRuleId === rule.id && (
                        <>
                          <Separator className="my-3" />
                          <RuleEditor
                            initialRule={rule}
                            cells={cells}
                            onSave={async (updates) => {
                              await updateRule(rule.id, updates)
                              setEditingRuleId(null)
                            }}
                            onCancel={() => setEditingRuleId(null)}
                          />
                        </>
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
    </div>
  )
}

function AutofixEditor({ rule, onUpdate }: { rule: TranslationRule; onUpdate: (af: RuleAutofix | undefined) => void }) {
  const [pattern, setPattern] = useState(rule.autofix?.pattern ?? "")
  const [replacement, setReplacement] = useState(rule.autofix?.replacement ?? "")
  const [flags, setFlags] = useState(rule.autofix?.flags ?? "gi")

  return (
    <>
      <Separator className="my-3" />
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">Saved autofix (regex)</p>
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
    </>
  )
}
