import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { OpfsFs } from "./opfs-fs";

// Deployed CORS proxy. Set VITE_GIT_CORS_PROXY at build time to override
// (dev/PR-preview builds point at codex-git-proxy-staging).
const DEFAULT_GIT_CORS_PROXY = "https://codex-git-proxy.ryderwishart.workers.dev";
export const GIT_CORS_PROXY =
  (import.meta.env.VITE_GIT_CORS_PROXY as string | undefined)?.replace(/\/+$/, "") ||
  DEFAULT_GIT_CORS_PROXY;

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
    corsProxy: GIT_CORS_PROXY,
    singleBranch: true,
    depth: 1,
    headers: { Authorization: `Basic ${btoa(`oauth2:${gitlabToken}`)}` },
    onAuth: () => ({ username: "oauth2", password: gitlabToken }),
    onAuthFailure: () => ({ cancel: true }),
    onProgress,
    onMessage,
  });
  // clone({singleBranch}) can omit the wildcard refspec, which later breaks
  // plain git.fetch({remote:"origin"}). Force a canonical refspec.
  await git.addRemote({
    fs: fs as unknown as git.FsClient,
    dir, remote: "origin", url, force: true,
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
