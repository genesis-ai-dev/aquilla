// Typed wrappers for the desktop hot-bundle channel (src-tauri/src/hot_bundle/mod.rs;
// docs/superpowers/specs/2026-11-05-desktop-hot-bundle.md). Every wrapper is a
// no-op / null outside Tauri, and `@tauri-apps/api/*` is imported dynamically so
// nothing Tauri reaches the browser bundle — same convention as connectivity.ts.
import { isTauriRuntime } from "./is-tauri"

/** A newer web bundle the shell has downloaded, verified and staged for the next launch. */
export interface StagedBundle {
  version: string
  sha: string
}

/** Mirrors hot_bundle/mod.rs `BundleStatus`. */
export interface BundleStatus {
  version: string
  sha: string
  source: "embedded" | "downloaded"
  staged: StagedBundle | null
  lastRollback: string | null
}

export interface ShellOutdatedPayload {
  minShellVersion: string
}

export interface BundleRolledBackPayload {
  version: string
}

export interface BundleEventPayloads {
  "bundle://staged": StagedBundle
  "bundle://shell-outdated": ShellOutdatedPayload
  "bundle://rolled-back": BundleRolledBackPayload
}

export type BundleEventName = keyof BundleEventPayloads

/** Idempotent: asks the shell to fetch the manifest and stage anything newer. Null = nothing new. */
export async function checkBundleUpdate(): Promise<StagedBundle | null> {
  if (!isTauriRuntime()) return null
  const { invoke } = await import("@tauri-apps/api/core")
  return (await invoke<StagedBundle | null>("check_bundle_update")) ?? null
}

/** Tells the shell this bundle booted, so it clears the `pending` marker and never rolls it back. */
export async function bundleBooted(): Promise<void> {
  if (!isTauriRuntime()) return
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("bundle_booted")
}

export async function getBundleStatus(): Promise<BundleStatus | null> {
  if (!isTauriRuntime()) return null
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<BundleStatus>("get_bundle_status")
}

/** The installed shell's own version, and the web bundle it is serving. */
export interface DesktopVersions {
  shell: string
  bundle: string | null
}

let desktopVersions: Promise<DesktopVersions | null> | undefined

/**
 * What the footer shows as "the version" on desktop. The web bundle is replaced
 * by hot updates and cannot know which shell it landed in, so the shell is asked
 * at run time. Neither value changes while the app is open (a staged bundle
 * applies on relaunch), so one answer is kept. Null outside Tauri or on failure.
 */
export function getDesktopVersions(): Promise<DesktopVersions | null> {
  if (!isTauriRuntime()) return Promise.resolve(null)
  desktopVersions ??= (async () => {
    try {
      const { getVersion } = await import("@tauri-apps/api/app")
      const [shell, status] = await Promise.all([getVersion(), getBundleStatus().catch(() => null)])
      return { shell, bundle: status?.version ?? null }
    } catch (error) {
      console.warn("[bundle] couldn't read the shell version", error)
      return null
    }
  })()
  return desktopVersions
}

/** Relaunches the shell; a staged bundle applies on that launch. */
export async function restartApp(): Promise<void> {
  if (!isTauriRuntime()) return
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("restart_app")
}

/**
 * Subscribes to one shell event. Returns the unsubscribe synchronously even
 * though Tauri's `listen` is async: unsubscribing before the listener lands
 * still detaches it once it does. A no-op outside Tauri.
 */
export function subscribeBundleEvent<Name extends BundleEventName>(
  name: Name,
  onEvent: (payload: BundleEventPayloads[Name]) => void,
): () => void {
  if (!isTauriRuntime()) return () => {}
  let unlisten: (() => void) | undefined
  let cancelled = false
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<BundleEventPayloads[Name]>(name, (event) => onEvent(event.payload)))
    .then((stop) => {
      if (cancelled) stop()
      else unlisten = stop
    })
    .catch((error: unknown) => console.warn(`[bundle] couldn't listen for ${name}`, error))
  return () => {
    cancelled = true
    unlisten?.()
  }
}
