import { useCallback, useMemo } from "react"
import { v4 as uuid } from "uuid"
import type {
  ProjectRecord,
  TranslationRule,
  RulePenalties,
  AlgorithmicCheckOverride,
  BuiltinCheckId,
} from "@/lib/parsers/types"
import { patchProject } from "@/lib/store/project-index"
import { resolveBuiltinRules } from "@/lib/lqa/builtin-resolver"

export function useRules(project: ProjectRecord | null, refresh: () => void) {
  const userRules = project?.rules || []
  const algorithmicChecks = project?.algorithmicChecks
  const penalties: RulePenalties = project?.rulePenalties || { major: 15, minor: 5 }

  const builtinRules = useMemo(
    () => resolveBuiltinRules(algorithmicChecks),
    [algorithmicChecks],
  )

  // Built-ins first so they appear at the top of the rule pipeline. Order
  // doesn't affect correctness (each rule is independent) but is stable.
  const rules = useMemo(
    () => [...builtinRules, ...userRules],
    [builtinRules, userRules],
  )

  const addRule = useCallback(async (rule: Omit<TranslationRule, "id" | "createdAt">) => {
    if (!project) return
    const newRule: TranslationRule = { ...rule, id: uuid(), createdAt: new Date().toISOString() }
    await patchProject(project.id, (p) => ({ ...p, rules: [...(p.rules || []), newRule] }))
    refresh()
  }, [project, refresh])

  const updateRule = useCallback(async (ruleId: string, updates: Partial<TranslationRule>) => {
    if (!project) return
    // Built-in rules update via setBuiltinOverride; reject here.
    if (ruleId.startsWith("builtin:")) return
    await patchProject(project.id, (p) => ({
      ...p,
      rules: (p.rules || []).map((r) => r.id === ruleId ? { ...r, ...updates } : r),
    }))
    refresh()
  }, [project, refresh])

  const deleteRule = useCallback(async (ruleId: string) => {
    if (!project) return
    if (ruleId.startsWith("builtin:")) return
    await patchProject(project.id, (p) => ({
      ...p,
      rules: (p.rules || []).filter((r) => r.id !== ruleId),
    }))
    refresh()
  }, [project, refresh])

  const updatePenalties = useCallback(async (newPenalties: RulePenalties) => {
    if (!project) return
    await patchProject(project.id, (p) => ({ ...p, rulePenalties: newPenalties }))
    refresh()
  }, [project, refresh])

  const setBuiltinOverride = useCallback(async (
    checkId: BuiltinCheckId,
    override: AlgorithmicCheckOverride,
  ) => {
    if (!project) return
    await patchProject(project.id, (p) => ({
      ...p,
      algorithmicChecks: { ...(p.algorithmicChecks ?? {}), [checkId]: override },
    }))
    refresh()
  }, [project, refresh])

  return {
    rules,
    userRules,
    builtinRules,
    penalties,
    addRule,
    updateRule,
    deleteRule,
    updatePenalties,
    setBuiltinOverride,
  }
}
