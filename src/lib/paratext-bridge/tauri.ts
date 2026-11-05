// Typed wrappers over the Tauri commands in src-tauri/src/paratext.rs.
// `@tauri-apps/api` is imported dynamically so the browser SPA bundle never
// pulls it in (same convention as src/lib/offline/*).

import { isTauriRuntime } from "../offline/is-tauri"

export type RootSource = "registry" | "wine" | "default" | "user"

export interface DiscoveredRoot { path: string; source: RootSource }

export interface DiscoveredProject {
  path: string
  folderName: string
  settingsXml: string
  userAccessXml: string | null
  bookFiles: string[]
}

export interface RegisteredUser { name: string; email: string }

export interface Discovery {
  roots: DiscoveredRoot[]
  projects: DiscoveredProject[]
  registeredUser: RegisteredUser | null
  paratextRunning: boolean
}

export interface WriteResult { backupPath: string; newBlobHash: string }

export interface FileChangedEvent { projectPath: string; fileName: string; blobHash: string }

export const FILE_CHANGED_EVENT = "paratext:file-changed"

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new Error("ENOTDESKTOP: the Paratext bridge needs the desktop app")
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(cmd, args)
}

export const paratextTauri = {
  discover: () => invoke<Discovery>("paratext_discover"),
  addRoot: (path: string) => invoke<Discovery>("paratext_add_root", { path }),
  removeRoot: (path: string) => invoke<Discovery>("paratext_remove_root", { path }),
  readFile: async (projectPath: string, fileName: string) =>
    new Uint8Array(await invoke<number[] | ArrayBuffer>("paratext_read_file", { projectPath, fileName })),
  hashFile: (projectPath: string, fileName: string) => invoke<string>("paratext_hash_file", { projectPath, fileName }),
  writeBook: (projectPath: string, fileName: string, bytes: Uint8Array, expectedBlobHash: string) =>
    invoke<WriteResult>("paratext_write_book", { projectPath, fileName, bytes: Array.from(bytes), expectedBlobHash }),
  watch: (projectPath: string) => invoke<void>("paratext_watch", { projectPath }),
  unwatch: (projectPath: string) => invoke<void>("paratext_unwatch", { projectPath }),
  isRunning: () => invoke<boolean>("paratext_is_running"),
}

/** Subscribe to folder-change events. Returns an unlisten function. */
export async function onParatextFileChanged(handler: (e: FileChangedEvent) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  const { listen } = await import("@tauri-apps/api/event")
  return listen<FileChangedEvent>(FILE_CHANGED_EVENT, (ev) => handler(ev.payload))
}
