/**
 * Env overlay for the Playwright process.
 *
 * Playwright registers Node's synchronous module hooks unless
 * PLAYWRIGHT_FORCE_ASYNC_LOADER is set. On Node 22.15–22.17 and 24.0–24.2
 * those hooks crash while loading circular CommonJS (jszip) with
 * ERR_INTERNAL_ASSERTION "Unexpected module status 3". Fixed in 22.18.0 and
 * 24.3.0 (nodejs/node#58598). Git on this machine invokes the system Node,
 * which can be older than the editor's Node, so the pre-push suite has to
 * take the async loader there.
 */

export function playwrightLoaderEnv(nodeVersion = process.versions.node): Record<string, string> {
  if (!syncRegisterHooksCrashOnCircularCjs(nodeVersion)) return {}
  return { PLAYWRIGHT_FORCE_ASYNC_LOADER: "1" }
}

export function syncRegisterHooksCrashOnCircularCjs(nodeVersion: string): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(nodeVersion)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major === 22) return minor < 18
  if (major === 24) return minor < 3
  return false
}
