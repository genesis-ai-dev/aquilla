// Unit tests for the network error taxonomy (AQU-281).
//
// Verifies that:
//  1. Status codes map to human messages, not "HTTP NNN" strings.
//  2. Offline / network-failure detection works.
//  3. toUserFacingError correctly parses the "...failed: HTTP NNN — body" pattern
//     thrown by our fetch helpers.
//  4. UserError carries technical detail in .cause, never as .message.

import { describe, it, expect } from "vitest"
import {
  messageForStatus,
  isNetworkFailure,
  toUserFacingError,
  UserError,
  type NetworkErrorCategory,
} from "./user-error"

// ─── messageForStatus ────────────────────────────────────────────────────────

describe("messageForStatus", () => {
  it("maps 403 to a permission message, not 'HTTP 403'", () => {
    const result = messageForStatus(403, "", "project")
    expect(result.message).not.toMatch(/HTTP\s*403/)
    expect(result.message.toLowerCase()).toContain("permission")
    expect(result.category).toBe("forbidden" satisfies NetworkErrorCategory)
    expect(result.status).toBe(403)
  })

  it("maps 401 to a session-expired message", () => {
    const result = messageForStatus(401, "")
    expect(result.message).not.toMatch(/HTTP\s*401/)
    expect(result.message.toLowerCase()).toContain("session")
    expect(result.category).toBe("session-expired" satisfies NetworkErrorCategory)
  })

  it("maps 404 to a 'no longer exists' message", () => {
    const result = messageForStatus(404, "", "item")
    expect(result.message).not.toMatch(/HTTP\s*404/)
    expect(result.message.toLowerCase()).toContain("no longer exists")
    expect(result.category).toBe("not-found" satisfies NetworkErrorCategory)
  })

  it("maps 409 to a conflict message", () => {
    const result = messageForStatus(409, "")
    expect(result.message).not.toMatch(/HTTP\s*409/)
    expect(result.category).toBe("conflict" satisfies NetworkErrorCategory)
  })

  it("maps 410 to a 'permanently removed' message", () => {
    const result = messageForStatus(410, "", "invite")
    expect(result.message).not.toMatch(/HTTP\s*410/)
    expect(result.category).toBe("gone" satisfies NetworkErrorCategory)
  })

  it("maps 5xx to a generic server-error message", () => {
    for (const status of [500, 502, 503]) {
      const result = messageForStatus(status, "")
      expect(result.message).not.toMatch(/HTTP\s*\d{3}/)
      expect(result.category).toBe("server-error" satisfies NetworkErrorCategory)
    }
  })

  it("preserves raw body in .raw field", () => {
    const result = messageForStatus(403, "not allowed for this org")
    expect(result.raw).toBe("not allowed for this org")
  })
})

// ─── isNetworkFailure ────────────────────────────────────────────────────────

describe("isNetworkFailure", () => {
  it("detects 'Failed to fetch' TypeError", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true)
  })

  it("detects 'fetch failed' error", () => {
    expect(isNetworkFailure(new Error("fetch failed"))).toBe(true)
  })

  it("detects 'Network error' string", () => {
    expect(isNetworkFailure(new Error("Network error"))).toBe(true)
  })

  it("does not flag a 403 error as a network failure", () => {
    expect(isNetworkFailure(new Error("createProject failed: HTTP 403 — not allowed"))).toBe(false)
  })

  it("returns false for non-Error values", () => {
    expect(isNetworkFailure("oops")).toBe(false)
    expect(isNetworkFailure(null)).toBe(false)
  })
})

// ─── toUserFacingError ───────────────────────────────────────────────────────

describe("toUserFacingError", () => {
  it("maps 'Failed to fetch' to an offline message", () => {
    const result = toUserFacingError(new TypeError("Failed to fetch"))
    expect(result.message).not.toMatch(/HTTP\s*\d{3}/)
    expect(result.message.toLowerCase()).toContain("offline")
    expect(result.category).toBe("offline" satisfies NetworkErrorCategory)
  })

  it("parses 'HTTP NNN — body' patterns from fetch helpers (403)", () => {
    const err = new Error("createProject failed: HTTP 403 — You don't have access")
    const result = toUserFacingError(err, "project")
    expect(result.message).not.toMatch(/HTTP\s*403/)
    expect(result.category).toBe("forbidden" satisfies NetworkErrorCategory)
    expect(result.status).toBe(403)
  })

  it("parses 'HTTP NNN' without body (no dash)", () => {
    const err = new Error("listMyOrgs failed: HTTP 500")
    const result = toUserFacingError(err)
    expect(result.message).not.toMatch(/HTTP\s*500/)
    expect(result.category).toBe("server-error" satisfies NetworkErrorCategory)
  })

  it("passes through non-HTTP error messages as-is", () => {
    const err = new Error("Snapshot name is required.")
    const result = toUserFacingError(err)
    expect(result.message).toBe("Snapshot name is required.")
    expect(result.category).toBe("unknown" satisfies NetworkErrorCategory)
  })

  it("maps UserError without re-parsing", () => {
    const ue = new UserError(403, "raw body", "project")
    const result = toUserFacingError(ue)
    expect(result.message).toBe(ue.message)
    expect(result.category).toBe("forbidden" satisfies NetworkErrorCategory)
    expect(result.status).toBe(403)
  })

  it("returns generic fallback for non-Error values", () => {
    const result = toUserFacingError("some string error")
    expect(result.message).toBeTruthy()
    expect(result.category).toBe("unknown" satisfies NetworkErrorCategory)
  })
})

// ─── UserError ───────────────────────────────────────────────────────────────

describe("UserError", () => {
  it("message is human-readable, not 'HTTP NNN'", () => {
    const err = new UserError(403, "not allowed", "project")
    expect(err.message).not.toMatch(/HTTP\s*403/)
    expect(err.message.toLowerCase()).toContain("permission")
  })

  it("preserves technical detail in .cause", () => {
    const err = new UserError(403, "role check failed", "project")
    expect(String(err.cause)).toContain("HTTP 403")
    expect(String(err.cause)).toContain("role check failed")
  })

  it("raw field holds the original response body", () => {
    const err = new UserError(404, "item gone")
    expect(err.raw).toBe("item gone")
  })

  it("name is UserError", () => {
    const err = new UserError(500, "")
    expect(err.name).toBe("UserError")
  })
})
