import { patchProject } from "@/lib/store/project-index"

export async function markProjectHasAudioData(projectId: string): Promise<void> {
  await patchProject(projectId, (project) => (
    project.hasAnyAudioData ? project : { ...project, hasAnyAudioData: true }
  ))
}

export function markProjectHasAudioDataSoon(projectId: string): void {
  void markProjectHasAudioData(projectId).catch((e) => {
    console.warn("[audio] failed to mark project audio state", e)
  })
}
