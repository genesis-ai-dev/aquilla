import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

/** Local package names for the CLIs the e2e stack launches through npx. */
const PACKAGE_CANDIDATES: Record<string, readonly string[]> = {
  tsx: ["tsx"],
  vite: ["vite"],
  wrangler: ["wrangler"],
  playwright: ["@playwright/test", "playwright"],
}

/**
 * Node cannot CreateProcess `npx.cmd`. A shell can, but cmd.exe then re-parses
 * the arguments, which drops the JSON `--var` values wrangler needs. Resolve
 * the local JS bin and run it with node instead.
 */
function windowsNodeLaunch(
  args: readonly string[],
  cwd: string | undefined,
): { command: string; args: string[] } | undefined {
  const [bin, ...rest] = args
  if (!bin) return undefined
  const packages = PACKAGE_CANDIDATES[bin]
  if (!packages) return undefined
  const base = path.resolve(cwd ?? process.cwd())
  const packageJson = path.join(base, "package.json")
  if (!existsSync(packageJson)) return undefined
  const requireFrom = createRequire(packageJson)
  for (const name of packages) {
    let pkgJsonPath: string
    try {
      pkgJsonPath = requireFrom.resolve(`${name}/package.json`)
    } catch {
      continue
    }
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      bin?: string | Record<string, string>
    }
    const relative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[bin]
    if (!relative) continue
    return {
      command: process.execPath,
      args: [path.resolve(path.dirname(pkgJsonPath), relative), ...rest],
    }
  }
  return undefined
}

function launch<O extends SpawnOptions | SpawnSyncOptions>(
  command: string,
  args: readonly string[],
  options: O,
): { command: string; args: readonly string[]; options: O } {
  if (process.platform !== "win32" || command !== "npx") {
    return { command, args, options }
  }
  const cwd = typeof options.cwd === "string" ? options.cwd : undefined
  const rewritten = windowsNodeLaunch(args, cwd)
  if (rewritten) return { command: rewritten.command, args: rewritten.args, options }
  return { command, args, options: { ...options, shell: true } }
}

export function spawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const launched = launch(command, args, options)
  return nodeSpawn(launched.command, launched.args, launched.options)
}

export function spawnSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const launched = launch(command, args, options)
  return nodeSpawnSync(launched.command, launched.args, launched.options)
}
