import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The shipped desktop app serves the SPA from `app://localhost` under this CSP;
// `tauri dev` loads it from Vite with no CSP at all, so a directive the app
// needs can be missing here without any dev build noticing. v0.2.0–v0.2.3
// shipped with `script-src 'self'`: every WebAssembly compile was refused, the
// offline store's SQLite engine aborted at boot, and "Make available offline"
// silently did nothing.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function readCsp(file: string): Record<string, string> {
  const raw = readFileSync(path.join(REPO_ROOT, "src-tauri", file), "utf8")
  return (JSON.parse(raw) as { app: { security: { csp: Record<string, string> } } }).app.security.csp
}

describe("shipped desktop CSP", () => {
  const csp = readCsp("tauri.conf.json")
  const scriptSrc = csp["script-src"]!.split(/\s+/)

  it("lets WebAssembly compile (LiveStore's SQLite engine)", () => {
    expect(scriptSrc).toContain("'wasm-unsafe-eval'")
  })

  it("still refuses JavaScript eval", () => {
    expect(scriptSrc).not.toContain("'unsafe-eval'")
  })
})
