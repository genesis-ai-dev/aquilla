import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  parseWorktreeNewArgs,
  shouldUnsetUpstream,
  worktreeAddArgs,
  worktreeCheckout,
  worktreeSetupSteps,
  WORKTREE_NEW_USAGE,
} from "./lib/worktree-new"
import { assessHooks, probeHooks } from "./lib/hooks-armed"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function fail(message: string): never {
  console.error(`[worktree:new] ${message}`)
  process.exit(1)
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: process.env.CI ?? "1" },
  })
  if (result.error) fail(`failed to start ${command}: ${result.error.message}`)
  if ((result.status ?? 1) !== 0) {
    console.error(`[worktree:new] ${command} ${args.join(" ")} exited ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

function refExists(ref: string): boolean {
  return spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repoRoot }).status === 0
}

function remoteBranchExists(remote: string, branch: string): boolean {
  const result = spawnSync("git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    if (result.stderr) console.error(result.stderr)
    fail(`could not list heads on ${remote}`)
  }
  const needle = `refs/heads/${branch}`
  return result.stdout.split("\n").some((line) => line.endsWith(`\t${needle}`))
}

function upstream(dir: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
    cwd: dir,
    encoding: "utf8",
  })
  if (result.status !== 0) return null
  return result.stdout.trim() || null
}

function verifyHooks(dir: string): void {
  // Same predicate as `pnpm check:hooks` (scripts/lib/hooks-armed.ts, AQU-2161)
  // so the two entry points cannot drift apart.
  const verdict = assessHooks(probeHooks(dir), dir)
  if (verdict.armed) {
    console.log(`[worktree:new] hooks armed (core.hooksPath=${verdict.hooksPath})`)
    return
  }
  for (const line of verdict.lines) console.error(`[worktree:new] ${line}`)
  console.error("[worktree:new] pnpm install should have run the prepare script (husky). Re-run it in this worktree.")
  process.exit(1)
}

function main(): void {
  let args
  try {
    args = parseWorktreeNewArgs(process.argv.slice(2), repoRoot)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    if (!(error instanceof Error) || !error.message.includes("pnpm worktree:new")) {
      console.error(`\n${WORKTREE_NEW_USAGE}`)
    }
    process.exit(1)
  }

  console.log(`[worktree:new] fetching ${args.baseRef}`)
  run("git", ["fetch", args.remote, args.baseBranch], repoRoot)

  const localBranchExists = refExists(`refs/heads/${args.branch}`)
  const remoteExists = remoteBranchExists(args.remote, args.branch)
  const checkout = worktreeCheckout({
    localBranchExists,
    remoteBranchExists: remoteExists,
    baseRef: args.baseRef,
    remoteRef: `${args.remote}/${args.branch}`,
  })
  if (existsSync(args.dir)) fail(`directory already exists: ${args.dir}`)

  const addArgs = worktreeAddArgs(args.dir, args.branch, checkout)
  console.log(`[worktree:new] git ${addArgs.join(" ")}`)
  run("git", addArgs, repoRoot)

  const tracking = upstream(args.dir)
  if (shouldUnsetUpstream(tracking, args.baseRef)) {
    console.log(`[worktree:new] unsetting upstream ${tracking} so a bare git push cannot target it`)
    run("git", ["branch", "--unset-upstream"], args.dir)
  }

  for (const step of worktreeSetupSteps()) {
    const cwd = step.cwd === "." ? args.dir : path.join(args.dir, step.cwd)
    console.log(`[worktree:new] ${step.command} ${step.args.join(" ")} (${step.cwd})`)
    run(step.command, [...step.args], cwd)
  }

  verifyHooks(args.dir)
  console.log(args.dir)
}

main()
