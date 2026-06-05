// Tests for probeMicPermission — the gating check that runs BEFORE the
// 3-2-1 countdown begins. The core invariant being tested: recording must
// never start its countdown if mic permission is denied. This matters because
// a countdown into a missing permission wastes the speaker's preparation time
// and produces a confusing "failed recording" UX rather than an immediate,
// actionable error. (FRO-155)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { probeMicPermission } from "./probeMicPermission"

// Helpers to set up navigator stubs
function stubPermissionsApi(state: "granted" | "denied" | "prompt" | "throw") {
  Object.defineProperty(navigator, "permissions", {
    writable: true,
    value:
      state === "throw"
        ? {
            query: vi.fn().mockRejectedValue(new Error("unsupported")),
          }
        : {
            query: vi.fn().mockResolvedValue({ state }),
          },
  })
}

function stubGetUserMedia(result: "granted" | "denied" | "other-error" | "none") {
  if (result === "none") {
    Object.defineProperty(navigator, "mediaDevices", { writable: true, value: undefined })
    return
  }
  const getUserMedia =
    result === "granted"
      ? vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        })
      : result === "denied"
        ? vi.fn().mockRejectedValue(Object.assign(new DOMException("denied"), { name: "NotAllowedError" }))
        : vi.fn().mockRejectedValue(Object.assign(new DOMException("no mic"), { name: "NotFoundError" }))

  Object.defineProperty(navigator, "mediaDevices", {
    writable: true,
    value: { getUserMedia },
  })
}

beforeEach(() => {
  // Reset all navigator stubs
  Object.defineProperty(navigator, "permissions", { writable: true, value: undefined })
  Object.defineProperty(navigator, "mediaDevices", { writable: true, value: undefined })
})

describe("probeMicPermission — Permissions API path", () => {
  it("returns 'granted' when Permissions API reports granted — countdown is safe to start", async () => {
    stubPermissionsApi("granted")
    expect(await probeMicPermission()).toBe("granted")
  })

  it("returns 'denied' when Permissions API reports denied — countdown must NOT start", async () => {
    stubPermissionsApi("denied")
    expect(await probeMicPermission()).toBe("denied")
  })

  it("falls through to getUserMedia when Permissions API reports 'prompt'", async () => {
    stubPermissionsApi("prompt")
    stubGetUserMedia("granted")
    // Should actually call getUserMedia to acquire permission now (before countdown).
    expect(await probeMicPermission()).toBe("granted")
  })

  it("falls through to getUserMedia when Permissions API throws (unsupported descriptor)", async () => {
    stubPermissionsApi("throw")
    stubGetUserMedia("denied")
    expect(await probeMicPermission()).toBe("denied")
  })
})

describe("probeMicPermission — getUserMedia fallback path (no Permissions API)", () => {
  it("returns 'granted' when getUserMedia succeeds — countdown is safe to start", async () => {
    stubGetUserMedia("granted")
    expect(await probeMicPermission()).toBe("granted")
  })

  it("returns 'denied' on NotAllowedError — countdown must NOT start", async () => {
    stubGetUserMedia("denied")
    expect(await probeMicPermission()).toBe("denied")
  })

  it("returns 'prompt' on other errors (e.g. NotFoundError) — let recorder surface the real error", async () => {
    stubGetUserMedia("other-error")
    expect(await probeMicPermission()).toBe("prompt")
  })

  it("returns 'prompt' when mediaDevices is unavailable — let recorder surface the limitation", async () => {
    stubGetUserMedia("none")
    expect(await probeMicPermission()).toBe("prompt")
  })
})
