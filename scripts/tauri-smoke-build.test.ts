import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

interface Step { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string> }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file: string) => readFileSync(path.join(root, file), "utf8")

describe("native smoke build isolation (AQU-2640)", () => {
  it.each(["tauri-build.yml", "tauri-release.yml"])("%s preserves local smoke config and hosted installers", name => {
    const workflow = parse(read(`.github/workflows/${name}`))
    const steps = Object.values(workflow.jobs).flatMap(job => (job as { steps?: Step[] }).steps ?? [])
    const build = steps.find(step => step.name === "Build e2e binary")!
    // Tauri merges configuration left-to-right. The former final unsigned
    // override erased the local build command and embedded production assets.
    const configs = [...build.run!.matchAll(/--config\s+(\S+)/g)].map(match => JSON.parse(read(match[1])))
    const effective = Object.assign({}, ...configs.map(config => config.build))
    expect(effective.beforeBuildCommand).toBe("node scripts/build-desktop-e2e.mjs")
    expect(build.env?.NODE_OPTIONS).toContain("--max-old-space-size=")
    expect(build.env?.AQUILLA_BUNDLE_PUBKEY).toBeUndefined()
    if (name === "tauri-release.yml") {
      const smoke = steps.findIndex(step => step.name === "Run Tauri e2e smoke suite")
      const restore = steps.findIndex(step => step.name === "Restore hosted frontend after native smoke")
      const publish = steps.findIndex(step => step.uses?.startsWith("tauri-apps/tauri-action@"))
      expect(restore).toBeGreaterThan(smoke)
      expect(publish).toBeGreaterThan(restore)
      expect(steps[restore].if).toBe(build.if)
      expect(steps[restore].run).toBe("pnpm run build:hosted")
      expect(steps[restore].env?.VITE_AUTH_BASE).toBe("https://api.aquilla.app/identity")
      expect(steps[restore].env?.VITE_SYNC_WORKER_HOST).toBe("api.aquilla.app/sync")
      expect(steps[restore].env?.VITE_CHAT_BASE).toBe("https://api.aquilla.app/chat")
    }
  })
})
