/**
 * Unit tests for the FRO-234 systemPrompt-patch guard in ProjectWorkspace.
 *
 * Business rules:
 *   1. An empty/whitespace/null prompt must NEVER patch the server — a
 *      provider-only save (buildCompletionSettings materialises "" by default)
 *      must not wipe the existing server-side prompt.
 *   2. A non-empty prompt must only patch when the caller's role is at or above
 *      MAINTAINER (600) — same server-side floor as handleImported uses. Sub-600
 *      callers get a 403 server-side and patching locally creates IDB/server
 *      divergence.
 */

import { describe, it, expect } from "vitest"
import { shouldPatchSystemPrompt } from "./ProjectWorkspace"

describe("shouldPatchSystemPrompt (FRO-234)", () => {
  // ── empty / missing prompt ─────────────────────────────────────────────────

  it("returns false when systemPrompt is undefined (missing from completionSettings)", () => {
    expect(shouldPatchSystemPrompt(undefined, 700)).toBe(false)
  })

  it("returns false when systemPrompt is null", () => {
    expect(shouldPatchSystemPrompt(null, 700)).toBe(false)
  })

  it("returns false when systemPrompt is empty string (provider-only save)", () => {
    expect(shouldPatchSystemPrompt("", 700)).toBe(false)
  })

  it("returns false when systemPrompt is whitespace-only", () => {
    expect(shouldPatchSystemPrompt("   ", 700)).toBe(false)
  })

  // ── role gate ──────────────────────────────────────────────────────────────

  it("returns false for a non-empty prompt when role is below MAINTAINER (600)", () => {
    expect(shouldPatchSystemPrompt("Translate carefully.", 500)).toBe(false)
    expect(shouldPatchSystemPrompt("Translate carefully.", 0)).toBe(false)
    expect(shouldPatchSystemPrompt("Translate carefully.", 599)).toBe(false)
  })

  it("returns true for a non-empty prompt at exactly MAINTAINER level (600)", () => {
    expect(shouldPatchSystemPrompt("Translate carefully.", 600)).toBe(true)
  })

  it("returns true for a non-empty prompt above MAINTAINER (owner=700)", () => {
    expect(shouldPatchSystemPrompt("Translate carefully.", 700)).toBe(true)
  })

  // ── combined: empty prompt + sub-600 role (provider-only save scenario) ────

  it("returns false for empty prompt even with high role — never overwrites server with empty", () => {
    expect(shouldPatchSystemPrompt("", 700)).toBe(false)
    expect(shouldPatchSystemPrompt("  \n  ", 700)).toBe(false)
  })
})
