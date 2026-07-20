import { useState } from "react"
import { Sparkles, AlertTriangle, AlertCircle, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import { suggestRulesFromPairs, type RuleSuggestion } from "@/lib/rules/rule-suggester"
import { collectValidatedPairs, resolveProvider, DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { useFrontierHealth } from "@/lib/completion/frontier-health"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { addLlmCall } from "@/lib/usage/record-usage"
import { getProject, updateProject } from "@/lib/store/project-index"
import type { CompletionSettings, FileReference, TranslationRule } from "@/lib/parsers/types"

const FALLBACK_SETTINGS: CompletionSettings = {
  provider: "frontier",
  endpoint: "",
  model: "",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  llmHealthPenalty: 0.1,
}

interface RuleSuggestDialogProps {
  files: FileReference[]
  completionSettings: CompletionSettings | undefined
  onAdd: (rule: Omit<TranslationRule, "id" | "createdAt">) => void | Promise<void>
  projectId?: string
  /**
   * Snapshot of the project's cells (from useCells). When provided, validated
   * source→target pairs are extracted and sent to the LLM for pattern analysis.
   *
   * SWARM-TODO(memory-wiring): ProjectWorkspace.tsx — pass `fileCells` (or the
   * full `cells` snapshot) as the `cells` prop to RuleSuggestDialog wherever it
   * is rendered. Without this prop the dialog falls back to an empty list and
   * shows "No human-validated translations found."
   */
  cells?: { status: string; original: string; translated: string }[]
  /**
   * AQU-480: accepted suggestions are written via `onAdd` (addRule → project_settings,
   * MAINTAINER-gated). When false, the trigger is disabled-with-tooltip so a
   * below-floor user can't add rules that silently 403 and vanish. Defaults true.
   */
  canManage?: boolean
  deniedReason?: string | null
}

export function RuleSuggestDialog({ files: _files, completionSettings, onAdd, projectId, cells, canManage = true, deniedReason }: RuleSuggestDialogProps) {
  const { session } = useFrontierSession()
  const { available: frontierAvailable } = useFrontierHealth()
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<"idle" | "loading" | "review">("idle")
  const [error, setError] = useState<string | null>(null)
  const [pairCount, setPairCount] = useState(0)
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([])
  const [accepted, setAccepted] = useState<Set<number>>(new Set())

  const provider = completionSettings ? resolveProvider(completionSettings) : "frontier"
  const isConfigured = provider === "frontier"
    ? Boolean(session?.jwt) && frontierAvailable
    : Boolean(completionSettings?.endpoint && completionSettings?.model)

  async function handleSuggest() {
    if (!isConfigured) return
    const effectiveSettings = completionSettings ?? FALLBACK_SETTINGS
    setStage("loading")
    setError(null)
    try {
      const pairs = cells ? collectValidatedPairs(cells) : []
      setPairCount(pairs.length)

      if (pairs.length === 0) {
        setError("No human-validated translations found. Translate and validate some cells first.")
        setStage("idle")
        return
      }

      const result = await suggestRulesFromPairs(
        pairs,
        effectiveSettings,
        session,
        async (meta) => {
          if (!projectId) return
          const current = await getProject(projectId)
          if (!current) return
          await updateProject(addLlmCall(current, meta))
        },
      )
      if (result.length === 0) {
        setError("The LLM didn't find any testable patterns. Try validating more diverse translations.")
        setStage("idle")
        return
      }

      setSuggestions(result)
      setAccepted(new Set(result.map((_, i) => i))) // all selected by default
      setStage("review")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suggestion failed")
      setStage("idle")
    }
  }

  function toggleAccept(index: number) {
    setAccepted((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  async function handleCommit() {
    for (let i = 0; i < suggestions.length; i++) {
      if (!accepted.has(i)) continue
      const s = suggestions[i]
      await onAdd({
        name: s.name,
        description: s.description,
        severity: s.severity,
        source: "llm",
        scope: "project",
        check: s.check,
        enabled: true,
      })
    }
    // Reset and close
    setOpen(false)
    setStage("idle")
    setSuggestions([])
    setAccepted(new Set())
    setPairCount(0)
  }

  function handleClose(open: boolean) {
    setOpen(open)
    if (!open) {
      setStage("idle")
      setError(null)
      setSuggestions([])
      setAccepted(new Set())
    }
  }

  const triggerTooltip = !canManage
    ? (deniedReason ?? "You don't have permission to add rules")
    : isConfigured
      ? "Analyze validated edits with LLM"
      : "Configure LLM in settings first"

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger
        render={
          <AppTooltip content={triggerTooltip}>
            <Button
              variant="outline"
              size="sm"
              disabled={!isConfigured || !canManage}
            >
              <Sparkles className="mr-1 h-3.5 w-3.5" />
              Suggest from edits
            </Button>
          </AppTooltip>
        }
      />

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {stage === "review" ? `Review ${suggestions.length} suggested rule${suggestions.length !== 1 ? "s" : ""}` : "Suggest rules from your edits"}
          </DialogTitle>
        </DialogHeader>

        {stage === "idle" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The LLM will analyze your human-validated translations and propose rules based on patterns it finds.
              You'll review each suggestion before anything is saved.
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button onClick={handleSuggest} disabled={!isConfigured} className="w-full">
              <Sparkles className="mr-1 h-4 w-4" />
              Analyze my validated edits
            </Button>
            {!isConfigured && (
              <p className="text-xs text-muted-foreground">
                Configure your LLM endpoint in project settings first.
              </p>
            )}
          </div>
        )}

        {stage === "loading" && (
          <div className="flex flex-col items-center gap-2 py-6">
            <Spinner className="size-6 text-primary" />
            <p className="text-sm text-muted-foreground">
              {pairCount > 0 ? `Analyzing ${pairCount} validated pair${pairCount !== 1 ? "s" : ""}...` : "Loading validated translations..."}
            </p>
          </div>
        )}

        {stage === "review" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Analyzed {pairCount} validated pair{pairCount !== 1 ? "s" : ""}. Toggle suggestions to include or exclude.
            </p>
            <ul className="space-y-2 max-h-[400px] overflow-auto">
              {suggestions.map((s, i) => {
                const isAccepted = accepted.has(i)
                const Icon = s.severity === "major" ? AlertTriangle : AlertCircle
                const sevColor = s.severity === "major" ? "text-red-500" : "text-amber-500"
                const badgeColor = s.severity === "major"
                  ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                return (
                  <li
                    key={i}
                    className={`rounded border p-3 transition-opacity ${isAccepted ? "" : "opacity-40"}`}
                  >
                    <div className="flex items-start gap-2">
                      <Icon className={`h-4 w-4 flex-shrink-0 mt-0.5 ${sevColor}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium min-w-0 flex-1 break-words">{s.name}</span>
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeColor}`}>
                            {s.severity}
                          </span>
                        </div>
                        {s.description && (
                          <p className="mt-0.5 text-xs text-muted-foreground break-words">{s.description}</p>
                        )}
                        <div className="mt-1 rounded bg-muted/50 p-1.5">
                          <p className="font-mono text-[11px] leading-relaxed break-all">
                            {s.check.type === "source-target-match" && (
                              <>match both: <span className="font-semibold">{s.check.pattern}</span></>
                            )}
                            {s.check.type === "target-forbids" && (
                              <>target forbids: <span className="font-semibold">{s.check.targetPattern}</span></>
                            )}
                            {s.check.type === "source-requires-target" && (
                              <>if source has <span className="font-semibold">{s.check.sourcePattern}</span> → target needs <span className="font-semibold">{s.check.targetPattern}</span></>
                            )}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant={isAccepted ? "default" : "outline"}
                        size="sm"
                        onClick={() => toggleAccept(i)}
                        className="flex-shrink-0"
                      >
                        {isAccepted ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStage("idle")} className="flex-1">
                Back
              </Button>
              <Button
                onClick={handleCommit}
                disabled={accepted.size === 0}
                className="flex-1"
              >
                Add {accepted.size} rule{accepted.size !== 1 ? "s" : ""}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
