import { useEffect, useRef, useState, useCallback } from "react"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"
import { patchProject } from "@/lib/store/project-index"
import { listProjectMembers } from "@/lib/frontier/members"
import { useModelStatus } from "@/lib/audio/prefetch"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { DEFAULT_TTS_PROVIDER } from "@/lib/audio/tts-providers"

export interface ChecklistState {
  aiInstructions: boolean
  collaborators: boolean
  aiModels: boolean
  completedCount: number
  totalCount: number
}

/**
 * `collaboratorReach` counts project members beyond the caller. Sharing now
 * exclusively goes through server-side project_invites (redeemed in
 * /join/:token → project_members row), so the local IDB share table is gone
 * and only the server-tracked member list signals collaborator reach.
 *
 * AI provider is no longer in the checklist — for the happy path, signing
 * in to Frontier covers it. The advanced "personal endpoint override" lives
 * in user Settings, not project setup.
 */
export function deriveChecklistState(
  settings: Partial<CompletionSettings> | undefined,
  collaboratorReach: number,
  aiModelsReady: boolean
): ChecklistState {
  const aiInstructions = Boolean(settings?.systemPrompt?.trim())
  const collaborators = collaboratorReach > 0
  const items = [aiInstructions, collaborators, aiModelsReady]
  return {
    aiInstructions,
    collaborators,
    aiModels: aiModelsReady,
    completedCount: items.filter(Boolean).length,
    totalCount: items.length,
  }
}

export function useSetupChecklist(project: ProjectRecord | null) {
  const [memberCount, setMemberCount] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const { session } = useFrontierSession()

  // Session-sticky lock keyed by project id. Once the user clicks Dismiss in
  // this React session for this project, dismissed stays true even if a
  // concurrent patchProject call tries to modify other fields.
  const sessionDismissedForProjectRef = useRef<string | null>(null)

  useEffect(() => {
    if (!project) return
    const persisted = project.setupChecklistDismissed ?? false
    const sessionLocked = sessionDismissedForProjectRef.current === project.id
    setDismissed(persisted || sessionLocked)
  }, [project])

  // Project members live server-side. We exclude self from the count so a
  // single-owner project doesn't auto-complete the collaborators step. When
  // the network is unavailable we silently fall through to 0.
  useEffect(() => {
    if (!project || !session?.jwt) {
      setMemberCount(0)
      return
    }
    let cancelled = false
    listProjectMembers(session.jwt, project.id)
      .then((members) => {
        if (cancelled) return
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
  const mms = useModelStatus("mms")
  const ttsProvider = project?.ttsSettings?.provider ?? DEFAULT_TTS_PROVIDER
  const aiModelsReady =
    whisper.kind === "ready" &&
    (ttsProvider === "gemini"
      ? Boolean(project?.ttsSettings?.apiKey?.trim())
      : ttsProvider === "mms"
        ? mms.kind === "ready"
        : kokoro.kind === "ready")

  const state = deriveChecklistState(
    project?.completionSettings,
    memberCount,
    aiModelsReady,
  )

  const dismiss = useCallback(async () => {
    if (!project) return
    sessionDismissedForProjectRef.current = project.id
    setDismissed(true)
    await patchProject(project.id, (p) => ({ ...p, setupChecklistDismissed: true }))
  }, [project])

  const refreshShares = useCallback(async () => {
    if (!project) return
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
