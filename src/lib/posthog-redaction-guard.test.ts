// OPS-29 drift guard (docs/OPSEC-REVIEW-2026-09-14.md).
//
// The credential redaction added in `analytics-redaction.ts` is only worth
// anything if it is actually wired into `posthog.init`. This asserts that every
// `posthog.init(` call site in the SPA passes `before_send: redactCaptureEvent`
// — so a second analytics entry point (a brand, a desktop shell, a new app
// bundle) can't quietly ship without it. Same shape as the service-bearer drift
// scan from OPS-11: a control nobody re-checks is a control that decays.

import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

const SRC = path.resolve(__dirname, "..")

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

  it("passes before_send: redactCaptureEvent at every init site", () => {
    for (const file of initSites) {
      const source = fs.readFileSync(file, "utf8")
      expect(
        /before_send:\s*redactCaptureEvent/.test(source),
        `${path.relative(SRC, file)} calls posthog.init() without before_send: redactCaptureEvent — ` +
          "credential-bearing URLs (/join/:token, /link/:token, ?token=) would be exported verbatim.",
      ).toBe(true)
    }
  })
})
