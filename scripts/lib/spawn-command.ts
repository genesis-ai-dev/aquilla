import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process"

/**
 * Node's CreateProcess cannot launch the `npx.cmd` shim. On Windows a shell
 * resolves it; everywhere else this is a plain spawn.
 */
function windowsNpxOptions<T extends SpawnOptions | SpawnSyncOptions | undefined>(
  command: string,
  options: T,
): T {
  if (process.platform !== "win32" || command !== "npx") return options
  return { ...(options ?? {}), shell: true } as T
}

export function spawn(
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
): ChildProcess {
  return nodeSpawn(command, args, windowsNpxOptions(command, options))
}

export function spawnSync(
  command: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer> {
  return nodeSpawnSync(command, args, windowsNpxOptions(command, options))
}
