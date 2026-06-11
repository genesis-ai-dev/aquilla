import { useEffect, useRef, useState, useCallback } from "react"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"
import { patchProject } from "@/lib/store/project-index"
import { listProjectMembers } from "@/lib/frontier/members"
import { useModelStatus } from "@/lib/audio/prefetch"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { DEFAULT_TTS_PROVIDER } from "@/lib/audio/tts-providers"

// FRO-244: per-project localStorage key that records "this project's setup
// checklist has been auto-opened at least once". Stored as "1".
function autoShownKey(projectId: string): string {
  return `codex.setupAutoShown.${projectId}`
}

export function wasSetupAutoShown(projectId: string): boolean {
  try {
    return localStorage.getItem(autoShownKey(projectId)) === "1"
  } catch {
    return false
  }
}

export function markSetupAutoShown(projectId: string): void {
  try {
    localStorage.setItem(autoShownKey(projectId), "1")
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
  fileCount: number = 0
): ChecklistState {
  const importFiles = fileCount > 0
  const aiInstructions = Boolean(settings?.systemPrompt?.trim())
  const collaborators = collaboratorReach > 0
  const items = [importFiles, aiInstructions, collaborators, aiModelsReady]
  return {
    importFiles,
    aiInstructions,
    collaborators,
    aiModels: aiModelsReady,
    completedCount: items.filter(Boolean).length,
    totalCount: items.length,
  }
}

export function useSetupChecklist(project: ProjectRecord | null) {
  const [memberCount, setMemberCount] = useState(0)
  // FRO-244: tracks whether the async member fetch has completed for the
  // current project. We must NOT declare the checklist incomplete until this
  // resolves — otherwise a project-switch sees memberCount=0 (stale from A)
  // while the flag check reads B's id, burning B's auto-open flag on a
  // transiently-incomplete snapshot.
  const [membersFetched, setMembersFetched] = useState(false)
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

  // FRO-244: Reset member state when switching to a different project so we
  // don't evaluate shouldAutoOpen against the previous project's member count.
  useEffect(() => {
    setMemberCount(0)
    setMembersFetched(false)
  }, [project?.id])

  // Project members live server-side. We exclude self from the count so a
  // single-owner project doesn't auto-complete the collaborators step. When
  // the network is unavailable we silently fall through to 0.
  useEffect(() => {
    if (!project || !session?.jwt) {
      setMemberCount(0)
      setMembersFetched(true) // no session → can't have members, treat as resolved
      return
    }
    let cancelled = false
    listProjectMembers(session.jwt, project.id)
      .then((members) => {
        if (cancelled) return
        const others = (members ?? []).filter((m) => m.username !== session.username)
        setMemberCount(others.length)
        setMembersFetched(true)
      })
      .catch(() => {
        if (!cancelled) {
          setMemberCount(0)
          setMembersFetched(true) // network error — treat as resolved with 0
        }
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

  // FRO-244: model status is "resolved" once whisper + tts provider are no
  // longer in the "downloading" state. We must not declare models-complete
  // (or incomplete) before the status is known — otherwise a project with
  // pre-installed models would show as incomplete during the brief
  // "downloading 0/0" phase and trigger a spurious auto-open.
  const modelsResolved =
    whisper.kind !== "downloading" &&
    (ttsProvider === "gemini" || ttsProvider === "mms"
      ? mms.kind !== "downloading"
      : kokoro.kind !== "downloading")

  const state = deriveChecklistState(
    project?.completionSettings,
    memberCount,
    aiModelsReady,
    project?.files?.length ?? 0,
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

  // FRO-244: Call this once after auto-opening the drawer so it doesn't
  // reopen on subsequent visits / navigations to this project.
  const markAutoShownFn = useCallback(() => {
    if (!project?.id) return
    markSetupAutoShown(project.id)
  }, [project?.id])

  // FRO-244: true when the setup checklist should auto-open (once, on first visit
  // to an incomplete project). We read wasSetupAutoShown() directly at render
  // (not via mirrored state) so project-A→B switches don't inherit A's flag.
  // We also require membersFetched + modelsResolved before declaring incomplete —
  // a transiently-incomplete snapshot (member fetch still in flight on switch)
  // must NOT burn the shown-once flag or pop the drawer.
  const alreadyShown = project?.id ? wasSetupAutoShown(project.id) : true
  const shouldAutoOpen =
    !dismissed &&
    !alreadyShown &&
    membersFetched &&
    modelsResolved &&
    state.completedCount < state.totalCount &&
    !!project?.id

  return { state, dismissed, dismiss, refreshShares, shouldAutoOpen, markAutoShown: markAutoShownFn }
}
