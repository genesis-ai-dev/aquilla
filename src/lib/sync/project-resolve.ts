// Project resolution for READ paths (useProject, useProjectOrgId): the server
// first, and — in the desktop app only — the downloaded project's stored
// snapshot when the server can't be reached (src/lib/offline/project-snapshot.ts).
//
// The download itself keeps calling resolveCloudProjectResult directly: it must
// never be handed a stale snapshot in place of the server's answer.
//
// The offline modules are imported lazily, as outbox.ts does, so the browser
// SPA never pulls LiveStore into its bundle.
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { resolveCloudProjectResult, type ResolveProjectResult } from "./cloud-projects"

export type ProjectReadResult = ResolveProjectResult & {
  /** True when the project came from this device's offline copy, not the server. */
  fromOfflineCopy?: boolean
}

export async function resolveProjectForRead(projectId: string, jwt: string): Promise<ProjectReadResult> {
  const result = await resolveCloudProjectResult(projectId, jwt)
  if (!isTauriRuntime()) return result

  if (result.ok) {
    void withOfflineStore((store, snapshots) => snapshots.writeProjectSnapshot(store, result.project))
    return result
  }
  if (result.reason !== "unreachable") return result

  const snapshot = await withOfflineStore((store, snapshots) => snapshots.readProjectSnapshot(store, projectId))
  return snapshot ? { ok: true, project: snapshot, fromOfflineCopy: true } : result
}

async function withOfflineStore<T>(
  run: (
    store: Awaited<ReturnType<typeof import("@/lib/offline/store").getOfflineStore>>,
    snapshots: typeof import("@/lib/offline/project-snapshot"),
  ) => T,
): Promise<T | null> {
  try {
    const [{ getOfflineStore }, snapshots] = await Promise.all([
      import("@/lib/offline/store"),
      import("@/lib/offline/project-snapshot"),
    ])
    return run(await getOfflineStore(), snapshots)
  } catch (error) {
    // No usable offline store (e.g. a newer build owns it): behave as before.
    console.warn("[offline] project snapshot unavailable", error)
    return null
  }
}
