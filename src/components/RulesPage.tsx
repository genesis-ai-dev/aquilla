import { useEffect, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft, AlertTriangle, AlertCircle, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getProject } from "@/lib/store/project-index"
import { useRules } from "@/hooks/useRules"
import { RuleCreateDialog } from "./RuleCreateDialog"
import { RuleSuggestDialog } from "./RuleSuggestDialog"
import type { ProjectRecord } from "@/lib/parsers/types"

export function RulesPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [loading, setLoading] = useState(true)

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

  const { rules, penalties, addRule, updateRule, deleteRule, updatePenalties } = useRules(project, refresh)

  if (loading) return <div className="p-8 text-muted-foreground">Loading...</div>

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Editor
        </Button>
        <h2 className="font-semibold">Translation Rules</h2>
        <div className="flex-1" />
        <RuleSuggestDialog
          files={project?.files || []}
          completionSettings={project?.completionSettings}
          onAdd={addRule}
        />
        <RuleCreateDialog onAdd={addRule} />
      </header>

      <main className="mx-auto max-w-2xl space-y-6 p-6">
        {/* Penalty config */}
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

        {/* Rule list */}
        <Card>
          <CardHeader>
            <CardTitle>Rules ({rules.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {rules.length === 0 ? (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>No rules defined yet. You can:</p>
                <ul className="list-disc pl-5 space-y-1 text-xs">
                  <li><strong>Suggest from edits</strong> — let the LLM analyze your validated translations and propose rules</li>
                  <li><strong>+ Add Rule</strong> — define a rule manually with a regex pattern</li>
                </ul>
              </div>
            ) : (
              <ul className="space-y-2">
                {rules.map((rule) => {
                  const Icon = rule.severity === "major" ? AlertTriangle : AlertCircle
                  const badgeColor = rule.severity === "major" ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400" : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                  return (
                    <li key={rule.id} className="flex items-center gap-3 rounded border p-3">
                      <Icon className={`h-4 w-4 flex-shrink-0 ${rule.severity === "major" ? "text-red-500" : "text-amber-500"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{rule.name}</span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeColor}`}>{rule.severity}</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{rule.source}</span>
                        </div>
                        {rule.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{rule.description}</p>}
                      </div>
                      <label className="flex items-center gap-1 text-xs">
                        <input type="checkbox" checked={rule.enabled}
                          onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })} />
                        <span className="text-muted-foreground">Enabled</span>
                      </label>
                      <Button variant="ghost" size="sm" onClick={() => deleteRule(rule.id)}>
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Stubbed org rules */}
        <Card>
          <CardHeader><CardTitle>Organization Rules</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Organization-level rules will be available in a future update.</p>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
