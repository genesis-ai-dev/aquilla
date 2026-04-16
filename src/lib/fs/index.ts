import type { FsProvider, FsProviderOptions } from "./types";
import { isTauri } from "./runtime";
import { createWebFsProvider } from "./web-provider";

export type { FsProvider, FsProviderOptions };

export async function getFsProvider(
  repoKey: string,
  opts: FsProviderOptions = {},
): Promise<FsProvider> {
  if (isTauri()) {
    // Tauri provider lands in Phase 3; loaded lazily so web bundle
    // doesn't pull in @tauri-apps/api unnecessarily.
    const { createTauriFsProvider } = await import("./tauri-provider");
    return createTauriFsProvider(repoKey, opts);
  }
  return createWebFsProvider(repoKey, opts);
}
