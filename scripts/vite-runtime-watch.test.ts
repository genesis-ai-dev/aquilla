import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type UserConfigFnObject } from "vite"
import { expect, it } from "vitest"
import config from "../vite.config"

it("Vite watcher accepts application source but ignores generated worker email HTML", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aquilla-watch-")))
  const worker = join(root, "auth-worker")
  const emails = join(worker, ".wrangler/tmp/email/email-html")
  mkdirSync(emails, { recursive: true })
  writeFileSync(join(emails, "signup.html"), "generated email")
  writeFileSync(join(root, "index.html"), "application")
  writeFileSync(join(worker, "source.ts"), "export default {}")
  const server = await createServer({
    configFile: false, root, logLevel: "silent",
    server: { middlewareMode: true, watch: (config as UserConfigFnObject)({ command: "serve", mode: "development" }).server?.watch },
  })
  try {
    // Exercise the real filter used by Vite's bundled Chokidar scan and event
    // handlers. Its asynchronous ready event is not a portable scan barrier.
    // Explicitly fail on watcher upgrades that remove this internal contract.
    const watcher = server.watcher as typeof server.watcher & {
      _isIgnored: (path: string, stats: ReturnType<typeof statSync>) => boolean
    }
    expect(typeof watcher._isIgnored).toBe("function")
    for (const [path, ignored] of [
      [join(root, "index.html"), false],
      [join(worker, "source.ts"), false],
      [join(worker, ".wrangler"), true],
      [join(emails, "signup.html"), true],
    ] as const) {
      expect(watcher._isIgnored(path, statSync(path)), path).toBe(ignored)
    }
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 40_000)
