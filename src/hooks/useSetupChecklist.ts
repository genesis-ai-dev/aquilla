import { useEffect, useRef, useState, useCallback } from "react"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"
import { patchProject } from "@/lib/store/project-index"
import { listProjectMembers } from "@/lib/frontier/members"
import { useModelStatus } from "@/lib/audio/prefetch"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { DEFAULT_TTS_PROVIDER } from "@/lib/audio/tts-providers"

// AQU-694: per-project localStorage key recording that the user is currently
// *mid-setup* — i.e. they opened the setup checklist for this project and have
// not yet dismissed it or finished all steps. This is what lets a browser
// refresh restore the drawer where the user left off.
//
// It is deliberately NOT an auto-open flag: it is only ever *set* by the user
// opening the checklist, so a project the user has never engaged with (or has
// dismissed) can never reopen on load. Keyed by project, per-device
// (localStorage), matching the pre-existing `codex.setup*.<projectId>`
// convention. Stored as "1".
function setupInProgressKey(projectId: string): string {
  return `codex.setupInProgress.${projectId}`
}

export function isSetupInProgress(projectId: string): boolean {
  try {
    return localStorage.getItem(setupInProgressKey(projectId)) === "1"
  } catch {
    return false
  }
}

export function markSetupInProgress(projectId: string): void {
  try {
    localStorage.setItem(setupInProgressKey(projectId), "1")
  } catch {
    /* ignore quota/private-browsing errors */
  }
}

export function clearSetupInProgress(projectId: string): void {
  try {
    localStorage.removeItem(setupInProgressKey(projectId))
  } catch {
    /* ignore quota/private-browsing errors */
  }
}

export interface ChecklistState {
  importFiles: boolean
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
  aiModelsReady: boolean,
  fileCount: number = 0,
  // AQU-701: an explicit "we don't use voice/transcription" skip counts the
  // voice & transcription step as handled, so the checklist stops nagging.
  aiSetupSkipped: boolean = false
): ChecklistState {
  const importFiles = fileCount > 0
  const aiInstructions = Boolean(settings?.systemPrompt?.trim())
  const collaborators = collaboratorReach > 0
  const aiModels = aiModelsReady || aiSetupSkipped
  const items = [importFiles, aiInstructions, collaborators, aiModels]
  return {
    importFiles,
    aiInstructions,
    collaborators,
    aiModels,
    completedCount: items.filter(Boolean).length,
    totalCount: items.length,
  }
}

export function useSetupChecklist(project: ProjectRecord | null) {
  const [memberCount, setMemberCount] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const { session } = useFrontierSession()

  // Session-sticky lock keyed by project id. Once the user clicks Dismiss in
  // this React session for this project, `dismissed` stays true even if a
  // concurrent stale-project re-prop lacks setupChecklistDismissed.
  const sessionDismissedForProjectRef = useRef<string | null>(null)

  useEffect(() => {
    if (!project) return
    const persisted = project.setupChecklistDismissed ?? false
    const sessionLocked = sessionDismissedForProjectRef.current === project.id
    setDismissed(persisted || sessionLocked)
  }, [project])

  // Reset member state when switching to a different project so we don't show
  // the previous project's member count while B's fetch is in flight.
  useEffect(() => {
    setMemberCount(0)
  }, [project?.id])

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
  }, [project?.id, session?.jwt, session?.username])

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
    project?.files?.length ?? 0,
    project?.aiSetupSkipped ?? false,
  )

  const dismiss = useCallback(async () => {
    if (!project) return
    sessionDismissedForProjectRef.current = project.id
    setDismissed(true)
    // AQU-694: an explicit dismissal ends the mid-setup flow, so a later refresh
    // must not restore the drawer. Clear the in-progress flag here (independent
    // of the IDB-persisted `setupChecklistDismissed`, which is tracked
    // separately as AQU-695) so "dismissal wins" holds even if that persistence
    // is dropped on load.
    clearSetupInProgress(project.id)
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

  // AQU-694: the user opened the checklist — record that they are mid-setup so a
  // browser refresh restores the drawer. Callers invoke this from every open
  // path (the "Setup: n/N" chip, the onboarding hand-off, "Customize", …).
  const markInProgress = useCallback(() => {
    if (project?.id) markSetupInProgress(project.id)
  }, [project?.id])

  // AQU-694: the flow ended (all steps complete) — stop restoring the drawer.
  const clearInProgress = useCallback(() => {
    if (project?.id) clearSetupInProgress(project.id)
  }, [project?.id])

  // AQU-694: read at render (not mirrored into state) so a project A→B switch
  // reflects B's flag immediately without a state-update cycle.
  const wasInProgress = project?.id ? isSetupInProgress(project.id) : false

  return { state, dismissed, dismiss, refreshShares, markInProgress, clearInProgress, wasInProgress }
}
