import { useEffect, useRef, useState, useCallback } from "react"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"
import { patchProject } from "@/lib/store/project-index"
import { listShares } from "@/lib/sync/share-tokens"
import { listProjectMembers } from "@/lib/frontier/members"
import { useModelStatus } from "@/lib/audio/prefetch"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { DEFAULT_TTS_PROVIDER } from "@/lib/audio/gemini-tts"

export interface ChecklistState {
  aiProvider: boolean
  aiInstructions: boolean
  collaborators: boolean
  aiModels: boolean
  completedCount: number
  totalCount: number
}

/**
 * `collaboratorReach` counts any signal that the project is no longer
 * "just me": local share links the user created OR project members beyond
 * the caller. Either confirms they reached out to a teammate.
 */
export function deriveChecklistState(
  settings: Partial<CompletionSettings> | undefined,
  collaboratorReach: number,
  aiModelsReady: boolean
): ChecklistState {
  const aiProvider = Boolean(settings?.endpoint?.trim())
  const aiInstructions = Boolean(settings?.systemPrompt?.trim())
  const collaborators = collaboratorReach > 0
  const items = [aiProvider, aiInstructions, collaborators, aiModelsReady]
  return {
    aiProvider,
    aiInstructions,
    collaborators,
    aiModels: aiModelsReady,
    completedCount: items.filter(Boolean).length,
    totalCount: items.length,
  }
}

export function useSetupChecklist(project: ProjectRecord | null) {
  const [shareCount, setShareCount] = useState(0)
  const [memberCount, setMemberCount] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const { session } = useFrontierSession()

  // Session-sticky lock keyed by project id. Once the user clicks Dismiss in
  // this React session for this project, dismissed stays true even if a
  // concurrent patchProject call tries to modify other fields.
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

  // Project members live server-side. We exclude self from the count so a
  // single-owner project doesn't auto-complete the collaborators step. When
  // the network is unavailable we silently fall through to share-count only.
  useEffect(() => {
    if (!project || !session?.jwt) {
      setMemberCount(0)
      return
    }
    let cancelled = false
    listProjectMembers(session.jwt, project.id)
      .then((members) => {
        if (cancelled) return
        // null = no server-side access / project not server-side; treat as 0.
        const others = (members ?? []).filter((m) => m.username !== session.username)
        setMemberCount(others.length)
      })
      .catch(() => {
        if (!cancelled) setMemberCount(0)
      })
    return () => { cancelled = true }
  }, [project, session?.jwt, session?.username])

  const whisper = useModelStatus("whisper")
  const kokoro = useModelStatus("kokoro")
  const ttsProvider = project?.ttsSettings?.provider ?? DEFAULT_TTS_PROVIDER
  const aiModelsReady =
    whisper.kind === "ready" &&
    (ttsProvider === "gemini"
      ? Boolean(project?.ttsSettings?.apiKey?.trim())
      : kokoro.kind === "ready")

  const state = deriveChecklistState(
    project?.completionSettings,
    shareCount + memberCount,
    aiModelsReady,
  )

  const dismiss = useCallback(async () => {
    if (!project) return
    // Lock first so the UI is sticky even if IDB state changes from
    // another patchProject call.
    sessionDismissedForProjectRef.current = project.id
    setDismissed(true)
    // patchProject reads latest from IDB, applies the transform, and writes
    // back — so we never clobber concurrent writes (e.g. AI settings).
    await patchProject(project.id, (p) => ({ ...p, setupChecklistDismissed: true }))
  }, [project])

  const refreshShares = useCallback(async () => {
    if (!project) return
    const shares = await listShares(project.id)
    setShareCount(shares.length)
    if (session?.jwt) {
      try {
        const members = await listProjectMembers(session.jwt, project.id)
        const others = (members ?? []).filter((m) => m.username !== session.username)
        setMemberCount(others.length)
      } catch {
        /* network blip — keep last known count */
      }
    }
  }, [project, session?.jwt, session?.username])

  return { state, dismissed, dismiss, refreshShares }
}
