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

export async function ensureCheckout(deps: FetchDeps, p: { gitlabId: number; httpUrlToRepo: string; branch: string; wantSha: string }): Promise<FetchResult> {
  const exec = deps.exec ?? execFileP
  const dir = path.join(deps.clonesDir, String(p.gitlabId))
  const auth = deps.gitlabToken ? ["-c", `http.extraHeader=Authorization: Bearer ${deps.gitlabToken}`] : []
  const git = (args: string[], cwd?: string) => exec("git", [...auth, ...args], { cwd, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  const rev = async () => (await git(["rev-parse", "HEAD"], dir)).stdout.trim()
  const contains = async (sha: string) => { try { await git(["merge-base", "--is-ancestor", sha, "HEAD"], dir); return true } catch { return false } }

  let recloned = false
  const clone = async () => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(deps.clonesDir, { recursive: true })
    await git(["clone", "--depth", "50", "--single-branch", "--branch", p.branch, p.httpUrlToRepo, dir])
    recloned = true
  }
  if (!fs.existsSync(path.join(dir, ".git"))) await clone()
  else {
    try {
      await git(["fetch", "--depth", "50", "origin", p.branch], dir)
      await git(["merge", "--ff-only", "FETCH_HEAD"], dir)
    } catch {
      await clone()
    }
  }
  if (!(await contains(p.wantSha))) {
    // Shallow history may not include wantSha yet, or the hook raced the mirror. One deepen, then give up.
    try { await git(["fetch", "--deepen", "200", "origin", p.branch], dir) } catch { /* fall through */ }
    if (!(await contains(p.wantSha))) throw new Error(`checkout ${dir} at ${await rev()} does not contain wantSha ${p.wantSha}`)
  }
  return { dir, sha: await rev(), recloned }
}
