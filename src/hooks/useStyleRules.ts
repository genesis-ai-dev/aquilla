/**
 * useStyleRules — the style-rule library + applicability graph for one project
 * (AQU-934 phase 2).
 *
 * Thin-client read hook (AD-3): plain `useState` + a race-guarded `useEffect`
 * over the auth-worker HTTP surface, never React Query. Mutations call the API
 * and then refetch, so the server stays the single source of truth for the
 * lifecycle columns it owns (`status`, `version`, `humanEdited`, `reviewedBy`).
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  createStyleRule,
  deleteStyleRuleApplicability,
  listStyleRules,
  putStyleRuleApplicability,
  reviewStyleRule,
  updateStyleRule,
  type StyleRuleReviewAction,
} from "@/lib/rules/style-rules-api"
import type {
  CreateStyleRuleInput,
  RuleApplicability,
  StyleRule,
  UpdateStyleRuleInput,
  UpsertApplicabilityInput,
} from "@/lib/rules/style-rule-types"

export interface UseStyleRules {
  rules: StyleRule[]
  applicability: RuleApplicability[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  createRule: (input: CreateStyleRuleInput) => Promise<StyleRule | null>
  updateRule: (id: string, patch: UpdateStyleRuleInput) => Promise<StyleRule | null>
  review: (id: string, action: StyleRuleReviewAction) => Promise<StyleRule | null>
  setApplicability: (
    ruleId: string,
    row: UpsertApplicabilityInput,
  ) => Promise<RuleApplicability | null>
  removeApplicability: (ruleId: string, applicabilityId: string) => Promise<boolean>
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export function useStyleRules(projectId: string | null): UseStyleRules {
  const { session } = useFrontierSession()
  const jwt = session?.jwt
  const [rules, setRules] = useState<StyleRule[]>([])
  const [applicability, setApplicability] = useState<RuleApplicability[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Monotonic token: only the newest fetch may write state, so a project swap
  // mid-flight cannot land the previous project's library.
  const runRef = useRef(0)

  const load = useCallback(async () => {
    if (!projectId || !jwt) {
      setRules([])
      setApplicability([])
      return
    }
    const run = ++runRef.current
    setLoading(true)
    try {
      const result = await listStyleRules(jwt, projectId)
      if (run !== runRef.current) return
      setRules(result.rules)
      setApplicability(result.applicability)
      setError(null)
    } catch (err) {
      if (run !== runRef.current) return
      setError(messageOf(err, "Could not load the style-rule library."))
    } finally {
      if (run === runRef.current) setLoading(false)
    }
  }, [jwt, projectId])

  useEffect(() => {
    // No cleanup needed: `load` bumps the token on entry, so a re-run (or any
    // mutation's refetch) already invalidates the previous run's writes.
    void load()
  }, [load])

  const createRule = useCallback(
    async (input: CreateStyleRuleInput): Promise<StyleRule | null> => {
      if (!projectId || !jwt) return null
      try {
        const created = await createStyleRule(jwt, projectId, input)
        await load()
        return created.rule
      } catch (err) {
        setError(messageOf(err, "Could not propose the rule."))
        return null
      }
    },
    [jwt, load, projectId],
  )

  const updateRule = useCallback(
    async (id: string, patch: UpdateStyleRuleInput): Promise<StyleRule | null> => {
      if (!projectId || !jwt) return null
      try {
        const updated = await updateStyleRule(jwt, projectId, id, patch)
        await load()
        return updated
      } catch (err) {
        setError(messageOf(err, "Could not save the rule."))
        return null
      }
    },
    [jwt, load, projectId],
  )

  const review = useCallback(
    async (id: string, action: StyleRuleReviewAction): Promise<StyleRule | null> => {
      if (!projectId || !jwt) return null
      try {
        const reviewed = await reviewStyleRule(jwt, projectId, id, action)
        await load()
        return reviewed
      } catch (err) {
        setError(messageOf(err, "Could not record the review."))
        return null
      }
    },
    [jwt, load, projectId],
  )

  const upsertApplicability = useCallback(
    async (ruleId: string, row: UpsertApplicabilityInput): Promise<RuleApplicability | null> => {
      if (!projectId || !jwt) return null
      try {
        const saved = await putStyleRuleApplicability(jwt, projectId, ruleId, row)
        await load()
        return saved
      } catch (err) {
        setError(messageOf(err, "Could not save where the rule applies."))
        return null
      }
    },
    [jwt, load, projectId],
  )

  const removeApplicability = useCallback(
    async (ruleId: string, applicabilityId: string): Promise<boolean> => {
      if (!projectId || !jwt) return false
      try {
        await deleteStyleRuleApplicability(jwt, projectId, ruleId, applicabilityId)
        await load()
        return true
      } catch (err) {
        setError(messageOf(err, "Could not remove where the rule applies."))
        return false
      }
    },
    [jwt, load, projectId],
  )

  return {
    rules,
    applicability,
    loading,
    error,
    refresh: load,
    createRule,
    updateRule,
    review,
    setApplicability: upsertApplicability,
    removeApplicability,
  }
}
