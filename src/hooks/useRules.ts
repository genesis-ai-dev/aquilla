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
import type { Concept } from "@/lib/terminology/types"

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
  /**
   * Active concepts from this project's termbase subscriptions, already
   * flattened in subscription-priority order (see useSubscribedConcepts).
   * These are org-MANAGED, DETERMINISTIC terms: they are compiled through the
   * exact same compileConceptsToRules path as local terminology, so the
   * deterministic/probabilistic contract is identical for subscribed and local
   * concepts. Subscribed concepts take precedence over local terminology and
   * so are unioned ahead of it.
   */
  subscribedConcepts?: Concept[],
) {
  const userRules = project?.rules || []
  const algorithmicChecks = project?.algorithmicChecks
  const penalties: RulePenalties = project?.rulePenalties || { major: 15, minor: 5 }
  const terminology = project?.terminology

  const builtinRules = useMemo(
    () => resolveBuiltinRules(algorithmicChecks),
    [algorithmicChecks],
  )

  // Subscribed (org-managed) concepts union local terminology, subscribed
  // first (higher precedence), then compiled together so they share the
  // identical derive-on-read path. Subscribed concepts are already in
  // subscription-priority order from useSubscribedConcepts.
  const terminologyRules = useMemo(
    () =>
      compileConceptsToRules([
        ...(subscribedConcepts ?? []),
        ...(terminology ?? []),
      ]),
    [subscribedConcepts, terminology],
  )

  // Order: builtins → org rules → project rules → terminology
  // (subscribed + local). Project rules can shadow org rules (same id wins in
  // evaluation order).
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
    const updated = await patchProject(project.id, (p) => ({
      ...p,
      algorithmicChecks: { ...(p.algorithmicChecks ?? {}), [checkId]: override },
    }))
    // Sync to D1 like `rules`/`rulePenalties`: under AD-3 the read path is the
    // server projection, so an IDB-only write here is invisible to useProject.
    // Top-level settings keys replace wholesale — send the full merged map.
    void patchShared?.({
      algorithmicChecks: updated?.algorithmicChecks ?? {
        ...(project.algorithmicChecks ?? {}),
        [checkId]: override,
      },
    })
    refresh()
  }, [project, refresh, patchShared])

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
