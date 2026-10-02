// OPS-29 drift guard (docs/OPSEC-REVIEW-2026-09-14.md).
//
// The credential redaction added in `analytics-redaction.ts` is only worth
// anything if it is actually wired into `posthog.init`. This asserts that every
// `posthog.init(` call site in the SPA runs `redactCaptureEvent` as its
// `before_send` hook — so a second analytics entry point (a brand, a desktop
// shell, a new app bundle) can't quietly ship without it. Same shape as the
// service-bearer drift scan from OPS-11: a control nobody re-checks is a
// control that decays.
//
// AQU-1572 made `before_send` an array (the noisy-exception filter runs first).
// posthog-js runs the array in order, so redaction must stay the *last* entry:
// a hook after it could put a credential-bearing URL back.

import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

const SRC = path.resolve(__dirname, "..")

/**
 * The hooks an init site passes as `before_send`, in order — a lone identifier
 * or an array literal of identifiers. `null` when there is no `before_send`.
 */
function beforeSendHooks(source: string): string[] | null {
  const match = /before_send:\s*(\[[^\]]*\]|[\w$]+)/.exec(source)
  if (!match) return null
  return match[1]!
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectSourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe("posthog credential redaction is wired in", () => {
  // A real init site both imports the library and calls init — the second
  // condition alone also matches files that merely *mention* posthog.init in a
  // comment (src/test-setup.ts does).
  const initSites = collectSourceFiles(SRC).filter((f) => {
    const source = fs.readFileSync(f, "utf8")
    return source.includes('from "posthog-js"') && source.includes("posthog.init(")
  })

  it("finds the analytics entry point (the scan itself still works)", () => {
    expect(initSites.length).toBeGreaterThan(0)
  })

  it("runs redactCaptureEvent as the last before_send hook at every init site", () => {
    for (const file of initSites) {
      const hooks = beforeSendHooks(fs.readFileSync(file, "utf8"))
      expect(
        hooks?.at(-1),
        `${path.relative(SRC, file)} calls posthog.init() without redactCaptureEvent as its last before_send hook — ` +
          "credential-bearing URLs (/join/:token, /link/:token, ?token=) would be exported verbatim.",
      ).toBe("redactCaptureEvent")
    }
  })
})

describe("AQU-1572 exception noise filter and app_env are wired in", () => {
  const source = fs.readFileSync(path.join(SRC, "lib/posthog.ts"), "utf8")

  it("drops noisy $exception events ahead of redaction", () => {
    expect(beforeSendHooks(source)).toEqual(["dropNoisyExceptions", "redactCaptureEvent"])
  })

  it("keeps exception autocapture on — the ErrorBoundary window handlers rely on it", () => {
    expect(source).toContain("capture_exceptions: true")
  })

  it("registers the app_env super-property at init", () => {
    expect(source).toMatch(/posthog\.register\(\{\s*app_env: resolveAppEnv\(window\.location\)\s*\}\)/)
  })
})
