// Project resolution for READ paths (useProject, useProjectOrgId, and
// useProjectSettings' lane rows): the server first, and — in the desktop app
// only — the downloaded project's stored snapshot when the server can't be
// reached (src/lib/offline/project-snapshot.ts).
//
// The download itself keeps calling resolveCloudProjectResult directly: it must
// never be handed a stale snapshot in place of the server's answer.
//
// The stored copies belong to the account that fetched them (the JWT's
// subject): another account signed in on the same device never sees them.
//
// The offline modules are imported lazily, as outbox.ts does, so the browser
// SPA never pulls LiveStore into its bundle.
import { jwtSubject } from "@/lib/frontier/session-refresh"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { resolveCloudProjectResult, type ResolveProjectResult } from "./cloud-projects"
import type { ProjectSettingsResponse } from "./project-settings"

export type ProjectReadResult = ResolveProjectResult & {
  /** True when the project came from this device's offline copy, not the server. */
  fromOfflineCopy?: boolean
}

export async function resolveProjectForRead(projectId: string, jwt: string): Promise<ProjectReadResult> {
  const result = await resolveCloudProjectResult(projectId, jwt)
  const owner = jwtSubject(jwt)
  if (!isTauriRuntime() || !owner) return result

  if (result.ok) {
    void withOfflineStore((store, snapshots) => snapshots.writeProjectSnapshot(store, result.project, owner))
    return result
  }
  if (result.reason !== "unreachable") return result

  const snapshot = await withOfflineStore((store, snapshots) => snapshots.readProjectSnapshot(store, projectId, owner))
  return snapshot ? { ok: true, project: snapshot, fromOfflineCopy: true } : result
}

/** Desktop: keeps `jwt`'s account's settings response for {@link readOfflineProjectSettings}. */
export function rememberProjectSettingsOffline(projectId: string, jwt: string, settings: ProjectSettingsResponse): void {
  const owner = jwtSubject(jwt)
  if (!isTauriRuntime() || !owner) return
  void withOfflineStore((store, snapshots) => snapshots.writeProjectSettingsSnapshot(store, projectId, settings, owner))
}

/**
 * Desktop: `jwt`'s account's last settings response for a downloaded project,
 * for when the settings GET can't run. Null in the browser, or with nothing
 * stored for that account.
 */
export async function readOfflineProjectSettings(projectId: string, jwt: string): Promise<ProjectSettingsResponse | null> {
  const owner = jwtSubject(jwt)
  if (!isTauriRuntime() || !owner) return null
  return withOfflineStore((store, snapshots) => snapshots.readProjectSettingsSnapshot(store, projectId, owner))
}

/**
 * How long a read waits for the offline store before giving up on it. The store
 * can fail to boot without ever rejecting; without a bound, a project that can't
 * reach the server would sit on "loading" instead of saying so.
 */
export const OFFLINE_STORE_WAIT_MS = 3_000

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
    return run(await withinOfflineStoreWait(getOfflineStore()), snapshots)
  } catch (error) {
    // No usable offline store (e.g. a newer build owns it, or it never
    // finished opening): behave as before.
    console.warn("[offline] project snapshot unavailable", error)
    return null
  }
}

function withinOfflineStoreWait<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`offline store not open after ${OFFLINE_STORE_WAIT_MS}ms`)), OFFLINE_STORE_WAIT_MS)
  })
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer))
}
