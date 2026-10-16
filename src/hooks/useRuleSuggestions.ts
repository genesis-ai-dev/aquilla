/**
 * useRuleSuggestions — draft rules mined from the user's edits, reviewed in
 * place in the project rules list (replaces the AQU-198 "Suggest from edits"
 * modal, which lost every suggestion the moment it was closed).
 *
 * Each `suggest()` call asks the LLM for a handful more, optionally about a
 * topic ("punctuation"). Later calls look at a different window of the mined
 * edits and are told every rule name already saved, drafted or dismissed, so
 * "Suggest more" keeps finding new rules instead of repeating itself.
 *
 * Drafts are kept in sessionStorage per project, so leaving the page and
 * coming back does not throw them away either.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { mineCandidates, type MinerCell } from "@/lib/rules/edit-miner"
import { suggestRulesFromCandidates, type RuleSuggestion } from "@/lib/rules/rule-suggester"
import { collectValidatedPairs, resolveProvider, DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { useFrontierHealth } from "@/lib/completion/frontier-health"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { addLlmCall } from "@/lib/usage/record-usage"
import { getProject, updateProject } from "@/lib/store/project-index"
import type { CompletionSettings, TranslationRule } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { v4 as uuid } from "uuid"

const FALLBACK_SETTINGS: CompletionSettings = {
  provider: "frontier",
  endpoint: "",
  model: "",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  llmHealthPenalty: 0.1,
}

/** How far each batch advances through the ranked candidates. */
const BATCH_STRIDE = 20

export interface RuleDraft {
  id: string
  suggestion: RuleSuggestion
  evidence: string
  /** "approving" while its addRule write is in flight. */
  status: "draft" | "approving"
}

interface Stored {
  drafts: RuleDraft[]
  dismissed: string[]
  batches: number
}

const storageKey = (projectId: string) => `aquilla:rule-suggestions:${projectId}`

function load(projectId: string): Stored {
  try {
    const raw = sessionStorage.getItem(storageKey(projectId))
    if (raw) {
      const parsed = JSON.parse(raw) as Stored
      // An approval interrupted by navigation is a draft again, not stuck.
      return { ...parsed, drafts: parsed.drafts.map((d) => ({ ...d, status: "draft" })) }
    }
  } catch {
    // Storage blocked or corrupt — start empty.
  }
  return { drafts: [], dismissed: [], batches: 0 }
}

/** Same name and same check = the saved rule IS this draft. */
export function draftMatchesRule(draft: RuleDraft, rule: TranslationRule): boolean {
  return rule.name === draft.suggestion.name && JSON.stringify(rule.check) === JSON.stringify(draft.suggestion.check)
}

interface Options {
  projectId: string
  completionSettings: CompletionSettings | undefined
  cells: MinerCell[]
  cellsLoading: boolean
  cellsError: Error | undefined
  userRules: TranslationRule[]
  addRule: (rule: Omit<TranslationRule, "id" | "createdAt">) => void | Promise<void>
}

export function useRuleSuggestions({
  projectId,
  completionSettings,
  cells,
  cellsLoading,
  cellsError,
  userRules,
  addRule,
}: Options) {
  const t = useT()
  const { session } = useFrontierSession()
  const { available: frontierAvailable } = useFrontierHealth()

  const [stored, setStored] = useState<Stored>(() => load(projectId))
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null)

  const loadedFor = useRef(projectId)
  useEffect(() => {
    if (loadedFor.current === projectId) return
    loadedFor.current = projectId
    setStored(load(projectId))
    setMessage(null)
  }, [projectId])

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey(projectId), JSON.stringify(stored))
    } catch {
      // Not persisting is fine; the drafts still live for this visit.
    }
  }, [projectId, stored])

  const provider = completionSettings ? resolveProvider(completionSettings) : "frontier"
  const isConfigured =
    provider === "frontier"
      ? Boolean(session?.jwt) && frontierAvailable
      : Boolean(completionSettings?.endpoint && completionSettings?.model)

  const suggest = useCallback(async (focus: string) => {
    if (!isConfigured || cellsLoading || cellsError || loading) return
    setLoading(true)
    setMessage(null)
    try {
      const candidates = mineCandidates(cells, collectValidatedPairs(cells))
      if (candidates.length === 0) {
        setMessage({ kind: "info", text: t("rules.suggestFromEdits.noPatternsFound") })
        return
      }
      const exclude = [
        ...userRules.map((r) => r.name),
        ...stored.drafts.map((d) => d.suggestion.name),
        ...stored.dismissed,
      ]
      const result = await suggestRulesFromCandidates(
        candidates,
        completionSettings ?? FALLBACK_SETTINGS,
        session,
        async (meta) => {
          const current = await getProject(projectId)
          if (!current) return
          await updateProject(addLlmCall(current, meta))
        },
        { focus, exclude, offset: stored.batches * BATCH_STRIDE },
      )
      // The model is told what to skip, but it does not always listen.
      const known = new Set(exclude.map((name) => name.toLowerCase()))
      const fresh: RuleDraft[] = result.suggestions
        .map((suggestion, i) => ({ id: uuid(), suggestion, evidence: result.evidence[i] ?? "", status: "draft" as const }))
        .filter((d) => !known.has(d.suggestion.name.toLowerCase()))
      setStored((s) => ({ ...s, drafts: [...s.drafts, ...fresh], batches: s.batches + 1 }))
      if (fresh.length === 0) {
        setMessage({
          kind: "info",
          text: focus.trim()
            ? t("rules.suggestions.noneNewFocused", { focus: focus.trim() })
            : t("rules.suggestions.noneNew"),
        })
      }
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : t("rules.suggestFromEdits.analysisFailed") })
    } finally {
      setLoading(false)
    }
  }, [isConfigured, cellsLoading, cellsError, loading, cells, userRules, stored, completionSettings, session, projectId, t])

  const setStatus = (id: string, status: RuleDraft["status"]) =>
    setStored((s) => ({ ...s, drafts: s.drafts.map((d) => (d.id === id ? { ...d, status } : d)) }))

  const approve = useCallback(async (id: string) => {
    const draft = stored.drafts.find((d) => d.id === id)
    if (!draft || draft.status === "approving") return
    setStatus(id, "approving")
    try {
      await addRule({
        name: draft.suggestion.name,
        description: draft.suggestion.description,
        severity: draft.suggestion.severity,
        source: "llm",
        scope: "project",
        check: draft.suggestion.check,
        enabled: true,
      })
      setStored((s) => ({ ...s, drafts: s.drafts.filter((d) => d.id !== id) }))
    } catch {
      setStatus(id, "draft")
      setMessage({ kind: "error", text: t("rules.suggestions.addFailed") })
    }
  }, [stored.drafts, addRule, t])

  const dismiss = useCallback((id: string) => {
    setStored((s) => {
      const draft = s.drafts.find((d) => d.id === id)
      if (!draft) return s
      return { ...s, drafts: s.drafts.filter((d) => d.id !== id), dismissed: [...s.dismissed, draft.suggestion.name] }
    })
  }, [])

  // An approved draft disappears in the same render its saved rule appears
  // (the settings write is applied optimistically), so the list hands the
  // row over instead of briefly showing both.
  const drafts = stored.drafts.filter(
    (d) => d.status !== "approving" || !userRules.some((r) => draftMatchesRule(d, r)),
  )
  const adoptedDraftId = (rule: TranslationRule): string | undefined =>
    stored.drafts.find((d) => d.status === "approving" && draftMatchesRule(d, rule))?.id

  return {
    drafts,
    adoptedDraftId,
    hasSuggested: stored.batches > 0,
    loading,
    message,
    isConfigured,
    suggest,
    approve,
    dismiss,
  }
}
