import { useEffect, useState, useCallback } from "react"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"
import { getProject, updateProject } from "@/lib/store/project-index"
import { listShares } from "@/lib/sync/share-tokens"

export interface ChecklistState {
  aiProvider: boolean
  aiInstructions: boolean
  collaborators: boolean
  completedCount: number
  totalCount: number
}

export function deriveChecklistState(
  settings: Partial<CompletionSettings> | undefined,
  shareCount: number
): ChecklistState {
  const aiProvider = Boolean(settings?.endpoint?.trim())
  const aiInstructions = Boolean(settings?.systemPrompt?.trim())
  const collaborators = shareCount > 0
  const items = [aiProvider, aiInstructions, collaborators]
  return {
    aiProvider,
    aiInstructions,
    collaborators,
    completedCount: items.filter(Boolean).length,
    totalCount: items.length,
  }
}

export function useSetupChecklist(project: ProjectRecord | null) {
  const [shareCount, setShareCount] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!project) return
    let cancelled = false
    setDismissed(project.setupChecklistDismissed ?? false)
    listShares(project.id).then((shares) => {
      if (!cancelled) setShareCount(shares.length)
    })
    return () => { cancelled = true }
  }, [project])

  const state = deriveChecklistState(project?.completionSettings, shareCount)

  const dismiss = useCallback(async () => {
    if (!project) return
    // Re-read the latest project from the store so we don't clobber
    // intervening writes (e.g. AI settings saved through the checklist).
    const latest = await getProject(project.id)
    const base = latest ?? project
    await updateProject({ ...base, setupChecklistDismissed: true })
    setDismissed(true)
  }, [project])

  const refreshShares = useCallback(async () => {
    if (!project) return
    const shares = await listShares(project.id)
    setShareCount(shares.length)
  }, [project])

  return { state, dismissed, dismiss, refreshShares }
}
