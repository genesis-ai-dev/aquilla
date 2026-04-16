import type { FsProvider, FsProviderOptions } from "./types";
export async function createTauriFsProvider(
  _repoKey: string,
  _opts: FsProviderOptions = {},
): Promise<FsProvider> {
  throw new Error("not implemented yet (Phase 3)");
}
