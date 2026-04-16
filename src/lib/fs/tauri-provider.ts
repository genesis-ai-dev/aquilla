import type { FsProvider, FsProviderOptions } from "./types";

export async function createTauriFsProvider(
  _repoKey: string,
  _opts: FsProviderOptions = {},
): Promise<FsProvider> {
  throw new Error(
    "createTauriFsProvider: not implemented yet (Phase 3). " +
    "If you're seeing this in the browser, isTauri() returned a false positive.",
  );
}
