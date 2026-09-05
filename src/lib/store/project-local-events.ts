/** Device-local project-record writes (completion provider, TTS key, …).
 *  `useProject` instances other than the writer re-overlay IDB when this fires
 *  so the editor sparkle gate sees a Custom OpenRouter save immediately. */

export const PROJECT_LOCAL_UPDATED_EVENT = "aquilla:project-local-updated"

export interface ProjectLocalUpdatedDetail {
  projectId: string
}

export function broadcastProjectLocalUpdated(projectId: string): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<ProjectLocalUpdatedDetail>(PROJECT_LOCAL_UPDATED_EVENT, {
      detail: { projectId },
    }),
  )
}
