// Pure planning for `pnpm worktree:new`. The CLI in scripts/worktree-new.ts
// performs the git fetch, worktree add, installs, and hook check.

import path from "node:path"

const TICKET_RE = /aqu-\d+/i

export const WORKTREE_NEW_USAGE = `pnpm worktree:new <branch> [dir]

Creates a git worktree with a real install and Playwright's chromium build.
Starts from origin/dev. Pass --base <ref> to start from somewhere else
(origin/main). The default directory is a sibling of this repo named for the
branch ticket (../aquilla-aqu-1234).

  pnpm worktree:new aqu-1234-short-title
  pnpm worktree:new aqu-1234-short-title /path/to/dir
  pnpm worktree:new -- --base origin/main aqu-1234-short-title
`

export interface WorktreeNewArgs {
  branch: string
  dir: string
  remote: string
  baseBranch: string
  baseRef: string
}

export interface BaseRef {
  remote: string
  baseBranch: string
  baseRef: string
}

/** Directory name for a branch: `aquilla-aqu-1234` when the branch names a ticket. */
export function worktreeDirectoryName(branch: string): string {
  const ticket = TICKET_RE.exec(branch)?.[0].toLowerCase()
  if (ticket) return `aquilla-${ticket}`
  const slug = branch.replace(/[^A-Za-z0-9._]+/g, "-").replace(/^-+|-+$/g, "")
  return `aquilla-${slug || "worktree"}`
}

/** Sibling of the repo root, not a directory inside it. */
export function defaultWorktreeDir(repoRoot: string, branch: string): string {
  return path.resolve(repoRoot, "..", worktreeDirectoryName(branch))
}

/** `origin/dev` stays as-is. A bare `dev` means `origin/dev`. */
export function parseBaseRef(raw: string): BaseRef {
  const value = raw.trim()
  if (!value || value.startsWith("-") || /\s/.test(value)) {
    throw new Error(`invalid --base ref: ${raw}`)
  }
  const slash = value.indexOf("/")
  const remote = slash === -1 ? "origin" : value.slice(0, slash)
  const baseBranch = slash === -1 ? value : value.slice(slash + 1)
  if (!remote || !baseBranch || baseBranch.startsWith("/") || baseBranch.endsWith("/")) {
    throw new Error(`invalid --base ref: ${raw}`)
  }
  return { remote, baseBranch, baseRef: `${remote}/${baseBranch}` }
}

export function parseWorktreeNewArgs(argv: readonly string[], repoRoot: string): WorktreeNewArgs {
  let base = "origin/dev"
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    if (arg === "--") continue
    if (arg === "--base" || arg.startsWith("--base=")) {
      const value = arg === "--base" ? argv[++i] : arg.slice("--base=".length)
      if (!value || value.startsWith("-")) {
        throw new Error(`--base needs a ref\n\n${WORKTREE_NEW_USAGE}`)
      }
      base = value
      continue
    }
    if (arg.startsWith("-")) throw new Error(`unknown flag ${arg}\n\n${WORKTREE_NEW_USAGE}`)
    positionals.push(arg)
  }
  const branch = positionals[0]
  if (!branch || positionals.length > 2) throw new Error(WORKTREE_NEW_USAGE)
  if (branch.startsWith("-") || /\s/.test(branch) || branch.includes("..") || branch.endsWith("/")) {
    throw new Error(`invalid branch name: ${branch}`)
  }
  const baseRef = parseBaseRef(base)
  const dir = positionals[1]
    ? path.resolve(repoRoot, positionals[1])
    : defaultWorktreeDir(repoRoot, branch)
  if (path.resolve(dir) === path.resolve(repoRoot)) {
    throw new Error("refusing to use the current repo root as the new worktree directory")
  }
  return { branch, dir, ...baseRef }
}

export type WorktreeCheckout =
  | { action: "create"; startPoint: string }
  | { action: "checkout-local" }
  | { action: "checkout-remote"; startPoint: string }

/**
 * `-b` only when the branch does not exist yet. An existing local branch is
 * checked out as-is; an origin-only branch is created from that remote ref,
 * not from the base (which would discard the remote commits).
 */
export function worktreeCheckout(input: {
  localBranchExists: boolean
  remoteBranchExists: boolean
  baseRef: string
  remoteRef: string
}): WorktreeCheckout {
  if (input.localBranchExists) return { action: "checkout-local" }
  if (input.remoteBranchExists) return { action: "checkout-remote", startPoint: input.remoteRef }
  return { action: "create", startPoint: input.baseRef }
}

export function worktreeAddArgs(dir: string, branch: string, checkout: WorktreeCheckout): string[] {
  if (checkout.action === "checkout-local") return ["worktree", "add", dir, branch]
  return ["worktree", "add", "-b", branch, dir, checkout.startPoint]
}

/** A new branch created from origin/dev tracks origin/dev, so a bare `git push` would update dev. */
export function shouldUnsetUpstream(upstream: string | null, baseRef: string): boolean {
  return upstream === baseRef
}

export interface WorktreeSetupStep {
  /** Relative to the new worktree. "." is the root. */
  cwd: string
  command: string
  args: readonly string[]
}

export function worktreeSetupSteps(): WorktreeSetupStep[] {
  // Match .github/workflows/ci.yml. Root, sync-worker, and auth-worker install
  // with pnpm. agent-worker-tests runs `npm ci` against package-lock.json;
  // the pnpm-lock.yaml next to it is not the install CI uses.
  return [
    { cwd: ".", command: "pnpm", args: ["install", "--frozen-lockfile"] },
    { cwd: "sync-worker", command: "pnpm", args: ["install", "--frozen-lockfile"] },
    { cwd: "auth-worker", command: "pnpm", args: ["install", "--frozen-lockfile"] },
    { cwd: "agent-worker", command: "npm", args: ["ci"] },
    { cwd: ".", command: "pnpm", args: ["exec", "playwright", "install", "chromium"] },
  ]
}
