import { useEffect, useState, useMemo } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router-dom"
import { ArrowLeft, AlertTriangle, AlertCircle, Trash2, Wand2, ChevronDown, ChevronUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getProject } from "@/lib/store/project-index"
import { useRules } from "@/hooks/useRules"
import { RuleCreateDialog } from "./RuleCreateDialog"
import { RuleSuggestDialog } from "./RuleSuggestDialog"
import { BuiltinChecksList } from "./BuiltinChecksList"
import type { ProjectRecord, RuleAutofix, TranslationRule } from "@/lib/parsers/types"

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

  const { userRules, builtinRules, penalties, addRule, updateRule, deleteRule, updatePenalties, setBuiltinOverride } = useRules(project, refresh)

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
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Editor
        </Button>
        <h2 className="font-semibold">Translation Rules</h2>
        <div className="flex-1" />
        <RuleSuggestDialog files={project?.files || []} completionSettings={project?.completionSettings} onAdd={addRule} projectId={id} />
        <RuleCreateDialog onAdd={addRule} />
      </header>

      <main className="mx-auto max-w-2xl space-y-6 p-6">
        {usageSummary && (
          <p className="text-xs text-muted-foreground" title="LLM usage on this project">{usageSummary}</p>
        )}

        <Card>
          <CardHeader><CardTitle>Penalty Configuration</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="majpen">Major penalty (health points)</Label>
                <Input id="majpen" type="number" value={penalties.major}
                  onChange={(e) => updatePenalties({ ...penalties, major: Number(e.target.value) })} />
              </div>
              <div>
                <Label htmlFor="minpen">Minor penalty (health points)</Label>
                <Input id="minpen" type="number" value={penalties.minor}
                  onChange={(e) => updatePenalties({ ...penalties, minor: Number(e.target.value) })} />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* TODO(lqa-plan-b): wire real infractions when worker dispatch lands. */}
        <BuiltinChecksList
          builtinRules={builtinRules}
          infractions={new Map()}
          onSetOverride={setBuiltinOverride}
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
                        <Button size="sm" variant="outline" onClick={() => navigate(`/project/${id}?openRule=${rule.id}`)} title="Opens the editor with this rule's drawer">
                          <Wand2 className="mr-1 h-3.5 w-3.5" />
                          Try to fix all
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => toggleExpanded(rule.id)}>
                          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </Button>
                        <label className="flex items-center gap-1 text-xs">
                          <input type="checkbox" checked={rule.enabled}
                            onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })} />
                          <span className="text-muted-foreground">Enabled</span>
                        </label>
                        <Button variant="ghost" size="sm" onClick={() => deleteRule(rule.id)}>
                          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </div>

                      {expanded && (
                        <AutofixEditor rule={rule} onUpdate={(af) => updateRule(rule.id, { autofix: af })} />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
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
