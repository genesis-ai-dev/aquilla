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
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import { compileConceptsToRules } from "@/lib/terminology/compile"

/**
 * Optional callback that syncs the given partial settings slice to D1.
 * Pass `useProjectSettings(...).patch` from the caller.
 */
type PatchSharedFn = (partial: ProjectWideSettings) => Promise<unknown>

export function useRules(
  project: ProjectRecord | null,
  refresh: () => void,
  patchShared?: PatchSharedFn,
  orgRules?: TranslationRule[],
) {
  const userRules = project?.rules || []
  const algorithmicChecks = project?.algorithmicChecks
  const penalties: RulePenalties = project?.rulePenalties || { major: 15, minor: 5 }
  const terminology = project?.terminology

  const builtinRules = useMemo(
    () => resolveBuiltinRules(algorithmicChecks),
    [algorithmicChecks],
  )

  // Terminology concepts compiled to TranslationRule instances (derived on read).
  const terminologyRules = useMemo(
    () => compileConceptsToRules(terminology ?? []),
    [terminology],
  )

  // Order: builtins → org rules → project rules → terminology.
  // Project rules can shadow org rules (same id wins in evaluation order).
  const rules = useMemo(
    () => [...builtinRules, ...(orgRules ?? []), ...userRules, ...terminologyRules],
    [builtinRules, orgRules, userRules, terminologyRules],
  )

  const addRule = useCallback(async (rule: Omit<TranslationRule, "id" | "createdAt">) => {
    if (!project) return
    const newRule: TranslationRule = { ...rule, id: uuid(), createdAt: new Date().toISOString() }
    const updated = await patchProject(project.id, (p) => ({ ...p, rules: [...(p.rules || []), newRule] }))
    void patchShared?.({ rules: updated?.rules ?? [...(project.rules || []), newRule] })
    refresh()
  }, [project, refresh, patchShared])

  const updateRule = useCallback(async (ruleId: string, updates: Partial<TranslationRule>) => {
    if (!project) return
    // Built-in rules update via setBuiltinOverride; reject here.
    if (ruleId.startsWith("builtin:")) return
    const updated = await patchProject(project.id, (p) => ({
      ...p,
      rules: (p.rules || []).map((r) => r.id === ruleId ? { ...r, ...updates } : r),
    }))
    void patchShared?.({ rules: updated?.rules ?? (project.rules || []).map((r) => r.id === ruleId ? { ...r, ...updates } : r) })
    refresh()
  }, [project, refresh, patchShared])

  const deleteRule = useCallback(async (ruleId: string) => {
    if (!project) return
    if (ruleId.startsWith("builtin:")) return
    const updated = await patchProject(project.id, (p) => ({
      ...p,
      rules: (p.rules || []).filter((r) => r.id !== ruleId),
    }))
    void patchShared?.({ rules: updated?.rules ?? (project.rules || []).filter((r) => r.id !== ruleId) })
    refresh()
  }, [project, refresh, patchShared])

  const updatePenalties = useCallback(async (newPenalties: RulePenalties) => {
    if (!project) return
    await patchProject(project.id, (p) => ({ ...p, rulePenalties: newPenalties }))
    void patchShared?.({ rulePenalties: newPenalties })
    refresh()
  }, [project, refresh, patchShared])

  const setBuiltinOverride = useCallback(async (
    checkId: BuiltinCheckId,
    override: AlgorithmicCheckOverride,
  ) => {
    if (!project) return
    await patchProject(project.id, (p) => ({
      ...p,
      algorithmicChecks: { ...(p.algorithmicChecks ?? {}), [checkId]: override },
    }))
    // algorithmicChecks is device-local; not synced to D1.
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
