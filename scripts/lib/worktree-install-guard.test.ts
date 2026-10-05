// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  borrowedNodeModulesMessage,
  chromiumHeadlessShellDirectory,
  missingPlaywrightBrowserMessage,
  PLAYWRIGHT_CHROMIUM_INSTALL,
  readNodeModulesPlacements,
} from "./worktree-install-guard"

const fixtures: string[] = []
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  fixtures.push(dir)
  return dir
}

function realNodeModules(worktree: string, relative = "node_modules"): void {
  mkdirSync(path.join(worktree, relative), { recursive: true })
}

function linkNodeModules(worktree: string, relative: string, target: string): void {
  const link = path.join(worktree, relative)
  mkdirSync(path.dirname(link), { recursive: true })
  symlinkSync(target, link)
}

describe("borrowed node_modules", () => {
  it("refuses a symlink that resolves outside the worktree", () => {
    const worktree = temp("aquilla-wt-")
    const outside = temp("aquilla-other-")
    realNodeModules(outside)
    linkNodeModules(worktree, "node_modules", path.join(outside, "node_modules"))
    realNodeModules(worktree, "sync-worker/node_modules")
    linkNodeModules(worktree, "auth-worker/node_modules", path.join(outside, "node_modules"))

    const message = borrowedNodeModulesMessage(worktree, readNodeModulesPlacements(worktree))
    expect(message).toMatch(/node_modules →/)
    expect(message).toMatch(/auth-worker\/node_modules →/)
    expect(message).not.toMatch(/sync-worker\/node_modules →/)
    expect(message).toMatch(/pnpm install --frozen-lockfile/)
    expect(message).toMatch(/pnpm worktree:new/)
  })

  it("allows a real node_modules directory", () => {
    const worktree = temp("aquilla-wt-")
    realNodeModules(worktree)
    realNodeModules(worktree, "sync-worker/node_modules")
    realNodeModules(worktree, "auth-worker/node_modules")
    expect(borrowedNodeModulesMessage(worktree, readNodeModulesPlacements(worktree))).toBeNull()
  })

  it("allows a symlink whose target stays inside the worktree", () => {
    const worktree = temp("aquilla-wt-")
    const store = path.join(worktree, ".store")
    realNodeModules(store)
    realNodeModules(store, "sync")
    realNodeModules(store, "auth")
    linkNodeModules(worktree, "node_modules", path.join(store, "node_modules"))
    linkNodeModules(worktree, "sync-worker/node_modules", path.join(store, "sync"))
    linkNodeModules(worktree, "auth-worker/node_modules", path.join(store, "auth"))
    expect(borrowedNodeModulesMessage(worktree, readNodeModulesPlacements(worktree))).toBeNull()
  })

  it("does not treat a missing node_modules as borrowed", () => {
    const worktree = temp("aquilla-wt-")
    expect(borrowedNodeModulesMessage(worktree, readNodeModulesPlacements(worktree))).toBeNull()
  })

  it("refuses a dangling symlink", () => {
    const worktree = temp("aquilla-wt-")
    linkNodeModules(worktree, "node_modules", path.join(worktree, "missing-target"))
    expect(borrowedNodeModulesMessage(worktree, readNodeModulesPlacements(worktree))).toMatch(/dangling symlink/)
  })
})

describe("playwright browser check", () => {
  it("derives the headless-shell cache directory from chromium.executablePath()", () => {
    const chrome = [
      "",
      "Users",
      "me",
      "Library",
      "Caches",
      "ms-playwright",
      "chromium-1243",
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ].join(path.sep)
    expect(chromiumHeadlessShellDirectory(chrome)).toBe(
      ["", "Users", "me", "Library", "Caches", "ms-playwright", "chromium_headless_shell-1243"].join(path.sep),
    )
    expect(chromiumHeadlessShellDirectory("/usr/bin/chromium")).toBeNull()
  })

  it("names the install command when chrome or the headless shell is missing", () => {
    expect(missingPlaywrightBrowserMessage({
      chromePath: "/cache/chromium-1243/chrome",
      chromeExists: true,
      headlessShellDir: "/cache/chromium_headless_shell-1243",
      headlessShellExists: true,
    })).toBeNull()

    const missingShell = missingPlaywrightBrowserMessage({
      chromePath: "/cache/chromium-1243/chrome",
      chromeExists: true,
      headlessShellDir: "/cache/chromium_headless_shell-1243",
      headlessShellExists: false,
    })
    expect(missingShell).toMatch(/chromium_headless_shell-1243/)
    expect(missingShell).toContain(PLAYWRIGHT_CHROMIUM_INSTALL)

    const missingChrome = missingPlaywrightBrowserMessage({
      chromePath: "/cache/chromium-1243/chrome",
      chromeExists: false,
      headlessShellDir: null,
      headlessShellExists: false,
    })
    expect(missingChrome).toContain(PLAYWRIGHT_CHROMIUM_INSTALL)
  })
})

describe("e2e choke points", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

  it("runs the borrowed-node_modules check before affected e2e and from pre-push", () => {
    const affected = readFileSync(path.join(root, "scripts/e2e-affected.ts"), "utf8")
    const up = readFileSync(path.join(root, "scripts/e2e-up.ts"), "utf8")
    const hook = readFileSync(path.join(root, ".husky/pre-push"), "utf8")
    expect(affected).toMatch(/refuseBorrowedNodeModules/)
    expect(affected).toMatch(/refuseMissingPlaywrightChromium/)
    expect(up).toMatch(/refuseBorrowedNodeModules/)
    expect(up).toMatch(/refuseMissingPlaywrightChromium/)
    expect(hook).toMatch(/assert-worktree-node-modules\.ts/)
  })

  it("keeps the guard test on the e2e guard script", () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>
    }
    expect(packageJson.scripts?.["test:e2e:guard"]).toContain(
      "scripts/lib/worktree-install-guard.test.ts",
    )
    expect(packageJson.scripts?.["worktree:new"]).toBe("tsx scripts/worktree-new.ts")
  })
})
