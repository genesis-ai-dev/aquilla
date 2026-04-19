import { useEffect, useRef, useState, useCallback } from "react"
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

  // Session-sticky lock keyed by project id. Once the user clicks Dismiss in
  // this React session for this project, dismissed stays true even if IDB
  // gets clobbered by stale-state spreads in concurrent updateProject calls.
  // The ref resets when the user navigates to a different project.
  const sessionDismissedForProjectRef = useRef<string | null>(null)

  useEffect(() => {
    if (!project) return
    let cancelled = false
    const persisted = project.setupChecklistDismissed ?? false
    const sessionLocked = sessionDismissedForProjectRef.current === project.id
    setDismissed(persisted || sessionLocked)
    listShares(project.id).then((shares) => {
      if (!cancelled) setShareCount(shares.length)
    })
    return () => { cancelled = true }
  }, [project])

  const state = deriveChecklistState(project?.completionSettings, shareCount)

  const dismiss = useCallback(async () => {
    if (!project) return
    // Lock first so the UI is sticky even if the IDB write loses a race
    // with another updateProject call that spreads stale local state.
    sessionDismissedForProjectRef.current = project.id
    setDismissed(true)
    // Re-read the latest project from the store so we don't clobber
    // intervening writes (e.g. AI settings saved through the checklist).
    const latest = await getProject(project.id)
    const base = latest ?? project
    await updateProject({ ...base, setupChecklistDismissed: true })
  }, [project])

  const refreshShares = useCallback(async () => {
    if (!project) return
    const shares = await listShares(project.id)
    setShareCount(shares.length)
  }, [project])

  return { state, dismissed, dismiss, refreshShares }
}
