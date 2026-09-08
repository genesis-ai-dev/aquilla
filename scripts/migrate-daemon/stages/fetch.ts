// Stage 2: keep a disposable, id-keyed working copy of each GitLab project.
// The clone is a cache, never authoritative: if fast-forward is impossible we
// delete and re-clone rather than trying to repair (cf. scripts/lib/checkout-guard.ts,
// which refused; here the daemon owns the directory so wiping is safe).
import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

// Not `util.promisify(execFile)`: this repo's vite config runs test files
// through vite-plugin-node-polyfills (include: ["util", ...]) even under
// `@vitest-environment node`, and that polyfilled `util.promisify` drops
// node's `execFile[util.promisify.custom]` — the promise then resolves to
// bare stdout instead of `{ stdout, stderr }`. A hand-rolled wrapper sidesteps
// the polyfill entirely and behaves identically in production (real Node,
// no polyfill in play).
export const execFileP = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; maxBuffer?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(file, args as string[], options ?? {}, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
export interface FetchDeps { clonesDir: string; gitlabToken: string; exec?: typeof execFileP }
export interface FetchResult { dir: string; sha: string; recloned: boolean }

/** Basic-auth form git-over-HTTPS actually accepts for GitLab/Frontier
 *  tokens (cf. scripts/lib/checkout-guard.ts, scripts/migrate-fetch.ts).
 *  Only rewrites https:// URLs; anything else (e.g. file:// in tests) is
 *  returned unchanged. */
export function authedUrl(url: string, token: string): string {
  if (!token || !/^https:\/\//.test(url)) return url
  return url.replace(/^https:\/\//, `https://oauth2:${token}@`)
}

/** Strip any embedded token from text before it can reach logs/errors. */
export function redact(text: string, token?: string): string {
  let out = text.replace(/oauth2:[^@\s]+@/g, "oauth2:***@")
  if (token) out = out.split(token).join("***")
  return out
}

export async function ensureCheckout(deps: FetchDeps, p: { gitlabId: number; httpUrlToRepo: string; branch: string; wantSha: string }): Promise<FetchResult> {
  const exec = deps.exec ?? execFileP
  const dir = path.join(deps.clonesDir, String(p.gitlabId))
  const authed = authedUrl(p.httpUrlToRepo, deps.gitlabToken)
  const redactErr = <T>(promise: Promise<T>): Promise<T> =>
    promise.catch((e: unknown) => {
      if (e instanceof Error) {
        e.message = redact(e.message, deps.gitlabToken)
        const stderr = (e as { stderr?: unknown }).stderr
        if (typeof stderr === "string") (e as { stderr?: string }).stderr = redact(stderr, deps.gitlabToken)
      }
      throw e
    })
  const git = (args: string[], cwd?: string) =>
    redactErr(exec("git", args, { cwd, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }))
  const rev = async () => (await git(["rev-parse", "HEAD"], dir)).stdout.trim()
  const contains = async (sha: string) => { try { await git(["merge-base", "--is-ancestor", sha, "HEAD"], dir); return true } catch { return false } }

  let recloned = false
  const clone = async () => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(deps.clonesDir, { recursive: true })
    await git(["clone", "--depth", "50", "--single-branch", "--branch", p.branch, authed, dir])
    // Never persist the token in .git/config.
    await git(["remote", "set-url", "origin", p.httpUrlToRepo], dir)
    recloned = true
  }
  if (!fs.existsSync(path.join(dir, ".git"))) await clone()
  else {
    try {
      await git(["fetch", "--depth", "50", authed, p.branch], dir)
      await git(["merge", "--ff-only", "FETCH_HEAD"], dir)
    } catch {
      await clone()
    }
  }
  if (!(await contains(p.wantSha))) {
    // Shallow history may not include wantSha yet, or the hook raced the mirror. One deepen, then give up.
    try { await git(["fetch", "--deepen", "200", authed, p.branch], dir) } catch { /* fall through */ }
    if (!(await contains(p.wantSha))) {
      throw new Error(redact(`checkout ${dir} at ${await rev()} does not contain wantSha ${p.wantSha}`, deps.gitlabToken))
    }
  }
  return { dir, sha: await rev(), recloned }
}
