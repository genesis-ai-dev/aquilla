import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type UserConfigFnObject } from "vite"
import { expect, it } from "vitest"
import config from "../vite.config"

it("watches application HTML but excludes generated worker email HTML", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aquilla-watch-")))
  const emails = join(root, "auth-worker/.wrangler/tmp/email/email-html")
  mkdirSync(emails, { recursive: true })
  writeFileSync(join(emails, "signup.html"), "generated email")
  writeFileSync(join(root, "index.html"), "application")
  const server = await createServer({
    configFile: false, root, logLevel: "silent",
    server: { middlewareMode: true, watch: (config as UserConfigFnObject)({ command: "serve", mode: "development" }).server?.watch },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error("Vite watcher did not become ready")), 30_000)
      server.watcher.once("ready", () => { clearTimeout(watchdog); resolve() })
    })
    const watched = server.watcher.getWatched()
    expect(watched[root]).toContain("index.html")
    expect(Object.keys(watched).filter(directory => directory.includes(".wrangler"))).toEqual([])
    expect(Object.values(watched).flat()).not.toContain("signup.html")
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 40_000)
