import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type UserConfigFnObject } from "vite"
import { expect, it } from "vitest"
import config from "../vite.config"

it("watches application HTML but excludes generated worker email HTML", async () => {
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
    // Vite 8 starts its bundled Chokidar scan before createServer resolves.
    // Its ready event can already have fired on Linux. Observe the same latch
    // that emits ready so absence assertions run only after the complete scan.
    // Keep this explicit: a watcher upgrade must fail here, not skip the proof.
    const watcher = server.watcher as typeof server.watcher & { _readyEmitted: boolean }
    expect(typeof watcher._readyEmitted).toBe("boolean")
    await expect.poll(() => watcher._readyEmitted, { timeout: 30_000 }).toBe(true)
    const watched = server.watcher.getWatched()
    expect(watched[root]).toContain("index.html")
    expect(watched[worker]).toContain("source.ts")
    expect(watched[worker]).not.toContain(".wrangler")
    expect(Object.keys(watched).filter(directory => directory.includes(".wrangler"))).toEqual([])
    expect(Object.values(watched).flat()).not.toContain("signup.html")
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 40_000)
