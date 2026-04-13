import { useCallback } from "react"
import { v4 as uuid } from "uuid"
import type { ProjectRecord, TranslationRule, RulePenalties } from "@/lib/parsers/types"
import { updateProject } from "@/lib/store/project-index"

export function useRules(project: ProjectRecord | null, refresh: () => void) {
  const rules = project?.rules || []
  const penalties: RulePenalties = project?.rulePenalties || { major: 15, minor: 5 }

  const addRule = useCallback(async (rule: Omit<TranslationRule, "id" | "createdAt">) => {
    if (!project) return
    const newRule: TranslationRule = { ...rule, id: uuid(), createdAt: new Date().toISOString() }
    await updateProject({ ...project, rules: [...rules, newRule] })
    refresh()
  }, [project, rules, refresh])

  const updateRule = useCallback(async (ruleId: string, updates: Partial<TranslationRule>) => {
    if (!project) return
    const updated = rules.map((r) => r.id === ruleId ? { ...r, ...updates } : r)
    await updateProject({ ...project, rules: updated })
    refresh()
  }, [project, rules, refresh])

  const deleteRule = useCallback(async (ruleId: string) => {
    if (!project) return
    await updateProject({ ...project, rules: rules.filter((r) => r.id !== ruleId) })
    refresh()
  }, [project, rules, refresh])

  const updatePenalties = useCallback(async (newPenalties: RulePenalties) => {
    if (!project) return
    await updateProject({ ...project, rulePenalties: newPenalties })
    refresh()
  }, [project, refresh])

  return { rules, penalties, addRule, updateRule, deleteRule, updatePenalties }
}
