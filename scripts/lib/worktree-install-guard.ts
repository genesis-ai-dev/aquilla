// A worktree whose node_modules is a symlink to another checkout runs tests
// against that checkout's versions, and Vite refuses to serve files that
// resolve outside the worktree (wa-sqlite wasm never loads). pnpm's own
// links *inside* a real node_modules directory are a normal install.

import { createRequire } from "node:module"
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"

const require = createRequire(import.meta.url)

export const WORKTREE_NODE_MODULES = [
  "node_modules",
  "sync-worker/node_modules",
  "auth-worker/node_modules",
] as const

/** Printed as its own line so the fix is copy-pasteable. */
export const PLAYWRIGHT_CHROMIUM_INSTALL = "run: pnpm exec playwright install chromium"

export interface NodeModulesPlacement {
  /** Repo-relative, e.g. "sync-worker/node_modules". */
  relativePath: string
  /** lstat says this path itself is a symlink. A missing path is not one. */
  symlink: boolean
  /** Absolute realpath of a symlink; null when missing, not a symlink, or dangling. */
  resolvedPath: string | null
}

export function pathIsInside(parent: string, target: string): boolean {
  const root = realpathSync(parent)
  const resolved = realpathSync(target)
  const relative = path.relative(root, resolved)
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function readNodeModulesPlacements(worktreeRoot: string): NodeModulesPlacement[] {
  return WORKTREE_NODE_MODULES.map((relativePath) => {
    const absolute = path.join(worktreeRoot, relativePath)
    let stat
    try {
      stat = lstatSync(absolute)
    } catch {
      return { relativePath, symlink: false, resolvedPath: null }
    }
    if (!stat.isSymbolicLink()) return { relativePath, symlink: false, resolvedPath: null }
    try {
      return { relativePath, symlink: true, resolvedPath: realpathSync(absolute) }
    } catch {
      return { relativePath, symlink: true, resolvedPath: null }
    }
  })
}

/** Fix-it message, or null when every checked path is a real directory, missing, or a symlink that stays inside the worktree. */
export function borrowedNodeModulesMessage(
  worktreeRoot: string,
  placements: readonly NodeModulesPlacement[],
): string | null {
  const problems: string[] = []
  for (const placement of placements) {
    if (!placement.symlink) continue
    const outside = !placement.resolvedPath || !pathIsInside(worktreeRoot, placement.resolvedPath)
    if (!outside) continue
    problems.push(
      placement.resolvedPath
        ? `  ${placement.relativePath} → ${placement.resolvedPath}`
        : `  ${placement.relativePath} (dangling symlink)`,
    )
  }
  if (problems.length === 0) return null
  return [
    "Refusing to run: node_modules is a symlink that does not resolve inside this worktree.",
    ...problems,
    "A symlink to another checkout uses that checkout's dependency versions, and Vite will not serve files from outside this worktree (the e2e app cannot load wa-sqlite wasm).",
    "Remove the symlink and install here:",
    "  pnpm install --frozen-lockfile",
    "  pnpm --dir sync-worker install --frozen-lockfile",
    "  pnpm --dir auth-worker install --frozen-lockfile",
    "Or create the worktree with: pnpm worktree:new <branch>",
  ].join("\n")
}

export function refuseBorrowedNodeModules(worktreeRoot: string): void {
  const message = borrowedNodeModulesMessage(worktreeRoot, readNodeModulesPlacements(worktreeRoot))
  if (!message) return
  console.error(message)
  process.exit(1)
}

/**
 * `browserType.launch` in headless mode runs chromium-headless-shell.
 * `chromium.executablePath()` returns Chrome for Testing. Playwright stores
 * them as sibling cache directories, `chromium-<rev>` and
 * `chromium_headless_shell-<rev>`. A present Chrome binary with a missing
 * shell is the failure that exits every spec in 0.0s.
 */
export function chromiumHeadlessShellDirectory(chromeExecutablePath: string): string | null {
  const parts = chromeExecutablePath.split(path.sep)
  const index = parts.findIndex((part) => /^chromium-\d+$/.test(part))
  if (index < 0) return null
  const revision = parts[index]?.slice("chromium-".length)
  if (!revision) return null
  return [...parts.slice(0, index), `chromium_headless_shell-${revision}`].join(path.sep)
}

export function missingPlaywrightBrowserMessage(facts: {
  chromePath: string
  chromeExists: boolean
  /** null when the chrome path does not name a chromium-<revision> directory. */
  headlessShellDir: string | null
  headlessShellExists: boolean
}): string | null {
  const chromeOk = facts.chromePath !== "" && facts.chromeExists
  const shellKnown = facts.headlessShellDir !== null
  const shellOk = !shellKnown || facts.headlessShellExists
  if (chromeOk && shellOk) return null
  const missing: string[] = []
  if (!chromeOk) missing.push(facts.chromePath || "(chromium.executablePath() was empty)")
  if (shellKnown && !facts.headlessShellExists && facts.headlessShellDir) missing.push(facts.headlessShellDir)
  return [
    "Playwright browser executable is missing:",
    ...missing.map((entry) => `  ${entry}`),
    PLAYWRIGHT_CHROMIUM_INSTALL,
  ].join("\n")
}

function headlessShellPresent(dir: string): boolean {
  if (!existsSync(dir)) return false
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || current.depth > 3) continue
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (entry.name === "chrome-headless-shell" || entry.name === "chrome-headless-shell.exe") return true
      if (entry.isDirectory()) stack.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
    }
  }
  return false
}

/** Cheap: `chromium.executablePath()` plus an exists check. Does not launch a browser. */
export function inspectMissingPlaywrightChromium(): string | null {
  let chromePath: string
  try {
    const playwright = require("@playwright/test") as { chromium: { executablePath(): string } }
    chromePath = playwright.chromium.executablePath()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return [
      "Playwright's Chromium executable could not be resolved.",
      detail,
      PLAYWRIGHT_CHROMIUM_INSTALL,
    ].join("\n")
  }
  const headlessShellDir = chromiumHeadlessShellDirectory(chromePath)
  return missingPlaywrightBrowserMessage({
    chromePath,
    chromeExists: chromePath !== "" && existsSync(chromePath),
    headlessShellDir,
    headlessShellExists: headlessShellDir !== null && headlessShellPresent(headlessShellDir),
  })
}

export function refuseMissingPlaywrightChromium(): void {
  const message = inspectMissingPlaywrightChromium()
  if (!message) return
  console.error(message)
  process.exit(1)
}
