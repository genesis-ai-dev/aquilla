/**
 * Builder gates on the client: lint, the sandboxed smoke render (run here
 * through the in-process fake frame against the shipped runtime), and the
 * repair loop that feeds failures back to the model.
 */

import { describe, it, expect } from "vitest"
import { lintToolSource } from "../../../../shared/tools/lint"
import { validateManifest, type ToolManifest } from "../../../../shared/tools/manifest"
import { runBuildFlow, MAX_REPAIRS } from "../build-flow"
import { runToolSmoke } from "../smoke"
import { HEATMAP_MANIFEST, HEATMAP_SOURCE } from "../starters/heatmap-source"
import { STARTER_EXTENSIONS } from "../starters"
import type { BuildAttempt } from "../tools-api"
import { fakeSmokeFrame } from "./fake-frame"

const MANIFEST: ToolManifest = { name: "T", description: "", scopes: ["read:cells"], mounts: ["page"], apiRev: 1 }
const smokeOpts = { createFrame: () => fakeSmokeFrame() }
const usage = { promptTokens: 1, completionTokens: 1, cost: 0.1 }

describe("lint gate", () => {
  it("flags banned globals with a line number", () => {
    const res = lintToolSource(`<script>\nconst x = 1\nfetch("/api")\nnew WebSocket("wss://x")\nlocalStorage.x = 1\n</script>`)
    expect(res.ok).toBe(false)
    expect(res.issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/fetch\(\)/),
        expect.stringMatching(/WebSocket/),
        expect.stringMatching(/browser storage/),
      ]),
    )
    expect(res.issues.find((i) => /fetch/.test(i.message))?.line).toBe(3)
  })

  it("passes the vetted starter", () => {
    expect(lintToolSource(HEATMAP_SOURCE)).toEqual({ ok: true, issues: [] })
    expect(validateManifest(HEATMAP_MANIFEST).ok).toBe(true)
  })
})

describe("smoke gate", () => {
  it("catches a tool that throws", async () => {
    const res = await runToolSmoke(`<div></div><script>throw new Error("kaboom")</script>`, MANIFEST, smokeOpts)
    expect(res.ok).toBe(false)
    expect(res.errors.map((e) => e.message)).toContain("kaboom")
  })

  it("passes the starter heat map empty, and populated in every declared mount", async () => {
    const manifest = validateManifest(HEATMAP_MANIFEST).manifest
    expect(manifest).not.toBeNull()
    const res = await runToolSmoke(HEATMAP_SOURCE, manifest as ToolManifest, smokeOpts)
    expect(res.errors).toEqual([])
    expect(res.calls["files.list"]).toBe(1 + (manifest as ToolManifest).mounts.length)
    expect(res.calls["cells.list"]).toBeGreaterThanOrEqual(1)
  }, 30_000)
})

describe("every reviewed starter", () => {
  for (const starter of STARTER_EXTENSIONS) {
    it(`${starter.manifest.name} passes lint, manifest and smoke`, async () => {
      expect(lintToolSource(starter.source).issues).toEqual([])
      expect(validateManifest(starter.manifest).errors).toEqual([])
      const res = await runToolSmoke(starter.source, starter.manifest, smokeOpts)
      expect(res.errors).toEqual([])
    }, 30_000)
  }
})

describe("repair loop", () => {
  it("feeds lint and smoke failures back and saves the first passing attempt", async () => {
    const replies: BuildAttempt[] = [
      { ok: false, failure: "Lint errors:\n- fetch() is not available", source: "<script>fetch()</script>", manifestJson: "{}", lint: [], model: "m", usage },
      { ok: true, source: `<script>throw new Error("smoke fail")</script>`, manifest: MANIFEST, model: "m", usage },
      { ok: true, source: `<div>ok</div><script>aquilla.files.list()</script>`, manifest: MANIFEST, model: "m", usage },
    ]
    const seen: (string | undefined)[] = []
    const out = await runBuildFlow("a tool", {
      attempt: async (body) => {
        seen.push(body.repair?.failure)
        const next = replies.shift()
        if (!next) throw new Error("too many attempts")
        return next
      },
      smoke: (source, manifest) => runToolSmoke(source, manifest, smokeOpts),
    })
    expect(out.ok).toBe(true)
    expect(out.attempts).toBe(3)
    expect(out.cost).toBeCloseTo(0.3)
    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toMatch(/fetch/)
    expect(seen[2]).toMatch(/smoke fail/)
  })

  it(`gives up after ${MAX_REPAIRS} repairs`, async () => {
    let calls = 0
    const out = await runBuildFlow("a tool", {
      attempt: async () => {
        calls++
        return { ok: false, failure: "nope", source: null, manifestJson: null, lint: [], model: "m", usage }
      },
      smoke: async () => ({ ok: true, errors: [], calls: {} }),
    })
    expect(out.ok).toBe(false)
    expect(calls).toBe(MAX_REPAIRS + 1)
  })
})

describe("render gate (a tool must show something in each mount)", () => {
  const manifest: ToolManifest = { name: "Blank", description: "", scopes: ["read:cells"], mounts: ["page", "panel"], apiRev: 3 }

  it("fails a tool that loads but draws nothing", async () => {
    const res = await runToolSmoke(`<script>(async () => { await aquilla.files.list() })()</script>`, manifest, smokeOpts)
    expect(res.ok).toBe(false)
    expect(res.errors.map((e) => e.message).join("\n")).toMatch(/rendered nothing on screen in the "page" mount/)
  }, 30_000)

  it("fails a tool that draws in its page but not in its side panel", async () => {
    const src = `<div id="out"></div><script>(async () => {
      const files = await aquilla.files.list();
      if (aquilla.context.mount === "page") document.getElementById("out").textContent = files.length + " files";
    })()</script>`
    const res = await runToolSmoke(src, manifest, smokeOpts)
    const messages = res.errors.map((e) => `${e.state}: ${e.message}`)
    expect(messages.some((m) => m.startsWith("populated (panel)") && /"panel" mount/.test(m))).toBe(true)
    expect(messages.some((m) => m.startsWith("populated (page)"))).toBe(false)
  }, 30_000)

  it("passes a tool that shows its data in every mount", async () => {
    const src = `<h1>Word count</h1><div id="out">Loading…</div><script>(async () => {
      const files = await aquilla.files.list();
      document.getElementById("out").textContent = files.length + " files";
    })()</script>`
    const res = await runToolSmoke(src, manifest, smokeOpts)
    expect(res.errors).toEqual([])
  }, 30_000)
})
