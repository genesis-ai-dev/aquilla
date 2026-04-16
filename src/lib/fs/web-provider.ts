import { createOpfsFs, openOpfsRepoDir, resetOpfsRepoDir } from "@/lib/git/opfs-fs";
import type { FsProvider, FsProviderOptions } from "./types";

export async function createWebFsProvider(
  repoKey: string,
  opts: FsProviderOptions = {},
): Promise<FsProvider> {
  const dir = opts.reset
    ? await resetOpfsRepoDir(repoKey)
    : await openOpfsRepoDir(repoKey);
  return createOpfsFs(dir);
}
