import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { OpfsFs } from "./opfs-fs";

// Deployed CORS proxy (Task 19). Update if the Worker name changes.
export const GIT_CORS_PROXY = "https://codex-git-proxy.ryderwishart.workers.dev";

export interface CloneArgs {
  fs: OpfsFs;
  dir: string;              // absolute-ish path inside the fs (e.g. "/")
  url: string;              // https://gitlab.frontierrnd.com/group/repo.git
  gitlabToken: string;
  onProgress?: (event: git.GitProgressEvent) => void;
  onMessage?: (message: string) => void;
}

export async function cloneRepo({
  fs, dir, url, gitlabToken, onProgress, onMessage,
}: CloneArgs): Promise<{ headSha: string; branch: string }> {
  await git.clone({
    fs: fs as unknown as git.FsClient,
    http,
    dir,
    url,
    corsProxy: `${GIT_CORS_PROXY}/`,
    singleBranch: true,
    depth: 1,
    onAuth: () => ({ username: "oauth2", password: gitlabToken }),
    onProgress,
    onMessage,
  });
  const headSha = await git.resolveRef({
    fs: fs as unknown as git.FsClient,
    dir,
    ref: "HEAD",
  });
  const branch = (await git.currentBranch({
    fs: fs as unknown as git.FsClient,
    dir,
    fullname: false,
  })) ?? "main";
  return { headSha, branch };
}
