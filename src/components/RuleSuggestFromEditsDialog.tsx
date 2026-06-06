/**
 * RuleSuggestFromEditsDialog — FRO-198
 *
 * Mines the user's actual edits (repeated corrections, recent edits, validated
 * pairs), runs them through the LLM, and shows drafts in the generic
 * RuleImportReview screen with per-draft evidence strings.
 */
import { useState } from "react"
import { Sparkles, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { RuleImportReview } from "@/components/RuleImportReview"
import { mineCandidates } from "@/lib/rules/edit-miner"
import { suggestRulesFromCandidates } from "@/lib/rules/rule-suggester"
import { collectValidatedPairs, resolveProvider, DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { useFrontierHealth } from "@/lib/completion/frontier-health"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { addLlmCall } from "@/lib/usage/record-usage"
import { getProject, updateProject } from "@/lib/store/project-index"
import type { CompletionSettings, TranslationRule } from "@/lib/parsers/types"
import type { RuleSuggestion } from "@/lib/rules/rule-suggester"

const FALLBACK_SETTINGS: CompletionSettings = {
  provider: "frontier",
  endpoint: "",
  model: "",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  llmHealthPenalty: 0.1,
}

interface Props {
  completionSettings: CompletionSettings | undefined
  /**
   * Cell snapshot from useCells. Provides the data for edit mining.
   * SWARM-TODO(memory-wiring): ProjectWorkspace.tsx needs to pass `fileCells`
   * (or the full cells snapshot) as `cells` here. Without it the dialog falls
   * back to validated pairs only. Currently RulesSurface receives `validatedCells`
   * (already filtered); for mining we need ALL cells (including unvalidated) to
   * detect repeated edits. This prop accepts both — repeated-edit detection will
   * just only see validated if that's all we get.
   */
  cells?: { id?: string; original: string; translated: string; status: "empty" | "unvalidated" | "validated"; hasPendingEdit?: boolean }[]
  onAdd: (rule: Omit<TranslationRule, "id" | "createdAt">) => void | Promise<void>
  projectId?: string
}

type Stage = "idle" | "loading" | "review"

export function RuleSuggestFromEditsDialog({
  completionSettings,
  cells,
  onAdd,
  projectId,
}: Props) {
  const { session } = useFrontierSession()
  const { available: frontierAvailable } = useFrontierHealth()

  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<Stage>("idle")
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([])
  const [evidence, setEvidence] = useState<string[]>([])
  const [committing, setCommitting] = useState(false)
  const [miningStats, setMiningStats] = useState<{ repeated: number; recent: number; pairs: number } | null>(null)

  const provider = completionSettings ? resolveProvider(completionSettings) : "frontier"
  const isConfigured =
    provider === "frontier"
      ? Boolean(session?.jwt) && frontierAvailable
      : Boolean(completionSettings?.endpoint && completionSettings?.model)

  async function handleAnalyze() {
    if (!isConfigured) return
    const effectiveSettings = completionSettings ?? FALLBACK_SETTINGS
    setStage("loading")
    setError(null)

    try {
      const allCells = cells ?? []
      const validatedPairs = collectValidatedPairs(allCells)

      // Mine candidates from cells + validated pairs
      const candidates = mineCandidates(allCells, validatedPairs)

      // Count by kind for stats display
      const repeated = candidates.filter((c) => c.kind === "repeated").length
      const recent = candidates.filter((c) => c.kind === "recent").length
      const pairs = candidates.filter((c) => c.kind === "validated-pair").length
      setMiningStats({ repeated, recent, pairs })

      if (candidates.length === 0) {
        setError(
          "No edit patterns found. Translate some cells (validated pairs preferred) to generate suggestions.",
        )
        setStage("idle")
        return
      }

      const result = await suggestRulesFromCandidates(
        candidates,
        effectiveSettings,
        session,
        async (meta) => {
          if (!projectId) return
          const current = await getProject(projectId)
          if (!current) return
          await updateProject(addLlmCall(current, meta))
        },
      )

      if (result.suggestions.length === 0) {
        setError(
          "The LLM didn't find any testable patterns in your edits. Try validating more diverse translations.",
        )
        setStage("idle")
        return
      }

      setSuggestions(result.suggestions)
      setEvidence(result.evidence)
      setStage("review")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed")
      setStage("idle")
    }
  }

  async function handleCommit(accepted: number[]) {
    setCommitting(true)
    try {
      for (const i of accepted) {
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
      setOpen(false)
      resetState()
    } finally {
      setCommitting(false)
    }
  }

  function resetState() {
    setStage("idle")
    setError(null)
    setSuggestions([])
    setEvidence([])
    setMiningStats(null)
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) resetState()
  }

  const miningLabel =
    miningStats
      ? [
          miningStats.repeated > 0 && `${miningStats.repeated} repeated`,
          miningStats.recent > 0 && `${miningStats.recent} recent`,
          miningStats.pairs > 0 && `${miningStats.pairs} from pairs`,
        ]
          .filter(Boolean)
          .join(", ")
      : null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={!isConfigured}
            title={
              isConfigured
                ? "Mine your edits for rule patterns"
                : "Configure LLM in project settings first"
            }
          >
            <Sparkles className="mr-1 h-3.5 w-3.5" />
            Suggest from edits
          </Button>
        }
      />

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {stage === "review"
              ? `Review ${suggestions.length} suggested rule${suggestions.length !== 1 ? "s" : ""}`
              : "Suggest rules from your edits"}
          </DialogTitle>
        </DialogHeader>

        {stage === "idle" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Analyzes your repeated corrections, recent edits, and validated translations to
              propose testable rules. You'll review each suggestion before anything is saved.
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {!isConfigured && (
              <p className="text-xs text-muted-foreground">
                Configure your LLM endpoint in project settings first.
              </p>
            )}
            <Button onClick={handleAnalyze} disabled={!isConfigured} className="w-full">
              <Sparkles className="mr-1 h-4 w-4" />
              Analyze my edits
            </Button>
          </div>
        )}

        {stage === "loading" && (
          <div className="flex flex-col items-center gap-2 py-6">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Mining edit patterns…</p>
          </div>
        )}

        {stage === "review" && (
          <div className="space-y-1">
            {miningLabel && (
              <p className="text-xs text-muted-foreground mb-2">
                Mined patterns: {miningLabel}
              </p>
            )}
            <RuleImportReview
              drafts={suggestions}
              evidence={evidence}
              onCommit={handleCommit}
              onBack={() => setStage("idle")}
              committing={committing}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
