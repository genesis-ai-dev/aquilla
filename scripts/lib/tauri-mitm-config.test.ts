import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// `src-tauri/tauri.mitm.conf.json` restates the whole CSP rather than relying
// on Tauri's config merge to patch one directive. That is deliberate — it makes
// the dev-only relaxation reviewable in one place — but it introduces a drift
// risk: a directive tightened in tauri.conf.json would stay loose under
// `pnpm tauri:dev:mitm`, and the harness would then pass traffic the real app
// blocks. These tests pin the overlay as a pure superset of the base CSP.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

interface TauriCsp {
  app: { security: { csp: Record<string, string> } }
}

function readCsp(file: string): Record<string, string> {
  const raw = readFileSync(path.join(REPO_ROOT, "src-tauri", file), "utf8")
  return (JSON.parse(raw) as TauriCsp).app.security.csp
}

const BASE = readCsp("tauri.conf.json")
const MITM = readCsp("tauri.mitm.conf.json")

/** Loopback sources the harness needs, and the only additions it may make. */
const ALLOWED_ADDITIONS = ["http://127.0.0.1:*", "ws://127.0.0.1:*"]

describe("tauri.mitm.conf.json CSP overlay", () => {
  it("uses only root keys the Tauri config schema allows", () => {
    // The schema sets additionalProperties:false at the root, so a stray key
    // (a "$comment" documenting the file, say) makes `tauri dev --config`
    // reject it outright — and the harness only fails once you launch the app.
    const schema = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "node_modules", "@tauri-apps", "cli", "config.schema.json"),
        "utf8",
      ),
    ) as { properties: Record<string, unknown> }
    const overlay = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "src-tauri", "tauri.mitm.conf.json"), "utf8"),
    ) as Record<string, unknown>

    const allowed = new Set(Object.keys(schema.properties))
    expect(Object.keys(overlay).filter((k) => !allowed.has(k))).toEqual([])
  })

  it("covers exactly the same directives as the shipped CSP", () => {
    expect(Object.keys(MITM).sort()).toEqual(Object.keys(BASE).sort())
  })

  it("adds the loopback proxy sources connect-src needs", () => {
    const base = BASE["connect-src"]!.split(/\s+/)
    const mitm = MITM["connect-src"]!.split(/\s+/)
    for (const addition of ALLOWED_ADDITIONS) {
      expect(base).not.toContain(addition)
      expect(mitm).toContain(addition)
    }
  })

  it("only ever widens — never drops or rewrites a shipped source", () => {
    for (const [directive, baseValue] of Object.entries(BASE)) {
      const baseSources = baseValue.split(/\s+/).filter(Boolean)
      const mitmSources = MITM[directive]!.split(/\s+/).filter(Boolean)
      expect(
        baseSources.every((s) => mitmSources.includes(s)),
        `${directive} dropped a source present in tauri.conf.json`,
      ).toBe(true)
    }
  })

  it("widens only the directives the rewritten backend hosts reach", () => {
    // connect-src: fetch + the sync WebSocket. media-src: streamed cell audio
    // (`new Audio(<sync>/audio/...?t=)`). img-src: attachment previews
    // (`<img src=<sync>/attachments/...?t=>`). Every other directive must
    // match the shipped CSP exactly.
    const widened: Record<string, string[]> = {
      "connect-src": ALLOWED_ADDITIONS,
      "media-src": ["http://127.0.0.1:*"],
      "img-src": ["http://127.0.0.1:*"],
    }
    for (const [directive, baseValue] of Object.entries(BASE)) {
      const additions = widened[directive]
      if (!additions) {
        expect(MITM[directive], `${directive} must match tauri.conf.json exactly`).toBe(baseValue)
        continue
      }
      const baseSources = baseValue.split(/\s+/)
      const extra = MITM[directive]!.split(/\s+/).filter((s) => s && !baseSources.includes(s))
      expect(extra.sort(), `${directive} additions`).toEqual([...additions].sort())
    }
  })
})
