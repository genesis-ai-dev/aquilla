/**
 * AQU-1405: stale-chunk recovery after a redeploy.
 *
 * The regression these pin down is the one Biblica ETT hit four times in a
 * week: a tab open across a deploy navigates to a lazy route, the old chunk
 * hash is gone, and the panel stays blank until a manual hard-refresh. The
 * recovery must reload exactly once per failing chunk — never twice for the
 * same URL (that is the reload loop), and never *only* once per session (a
 * second deploy in the same session must still recover).
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  CHUNK_NOTICE_ID,
  CHUNK_RELOAD_KEY,
  chunkLoadKey,
  isChunkLoadError,
  markChunkAttempted,
  readAttemptedChunks,
  recoverFromChunkError,
  showUpdatingNotice,
} from "./chunk-reload"

const CHROME = "Failed to fetch dynamically imported module: https://aquilla.app/assets/app-chunk-BfoUWN3w.js"
const FIREFOX = "error loading dynamically imported module: https://aquilla.app/assets/app-chunk-BTYlqf0B2.js"
const SAFARI = "Importing a module script failed."

function harness(overrides: { storage?: Storage } = {}) {
  const reload = vi.fn()
  return {
    reload,
    deps: { storage: overrides.storage ?? sessionStorage, doc: document, reload, message: "Updating Aquilla…" },
  }
}

beforeEach(() => {
  sessionStorage.clear()
  document.getElementById(CHUNK_NOTICE_ID)?.remove()
})

describe("isChunkLoadError", () => {
  it("recognises the message every browser in the PostHog data produced", () => {
    expect(isChunkLoadError(new Error(CHROME))).toBe(true)
    expect(isChunkLoadError(new Error(FIREFOX))).toBe(true)
    expect(isChunkLoadError(new Error(SAFARI))).toBe(true)
    expect(isChunkLoadError("Loading chunk 42 failed")).toBe(true)
  })

  it("leaves ordinary application errors alone", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false)
    expect(isChunkLoadError(new Error("NetworkError when attempting to fetch resource"))).toBe(false)
  })
})

describe("chunkLoadKey", () => {
  it("keys on the failing chunk URL so two different chunks are two different failures", () => {
    expect(chunkLoadKey(new Error(CHROME))).toBe("https://aquilla.app/assets/app-chunk-BfoUWN3w.js")
    expect(chunkLoadKey(new Error(FIREFOX))).toBe("https://aquilla.app/assets/app-chunk-BTYlqf0B2.js")
    expect(chunkLoadKey(new Error(CHROME))).not.toBe(chunkLoadKey(new Error(FIREFOX)))
  })

  it("falls back to a root-relative asset path, then to the message itself", () => {
    expect(chunkLoadKey(new Error("Failed to fetch dynamically imported module: /assets/app-chunk-abc.js")))
      .toBe("/assets/app-chunk-abc.js")
    expect(chunkLoadKey(new Error(SAFARI))).toBe(SAFARI)
  })
})

describe("the one-shot guard", () => {
  it("reads a flag written by an older build as 'nothing attempted yet'", () => {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, "1")
    expect(readAttemptedChunks(sessionStorage)).toEqual([])
    expect(markChunkAttempted(sessionStorage, "/assets/a.js")).toBe(true)
  })

  it("claims a chunk once and refuses it thereafter", () => {
    expect(markChunkAttempted(sessionStorage, "/assets/a.js")).toBe(true)
    expect(markChunkAttempted(sessionStorage, "/assets/a.js")).toBe(false)
    expect(readAttemptedChunks(sessionStorage)).toEqual(["/assets/a.js"])
  })

  it("refuses when sessionStorage cannot record the attempt (no guard ⇒ no reload)", () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
    } as unknown as Storage
    expect(markChunkAttempted(broken, "/assets/a.js")).toBe(false)
  })
})

describe("recoverFromChunkError", () => {
  it("reloads once and paints the 'Updating …' notice on the first failure", () => {
    const { reload, deps } = harness()
    expect(recoverFromChunkError(new Error(CHROME), deps)).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
    const notice = document.getElementById(CHUNK_NOTICE_ID)
    expect(notice?.textContent).toBe("Updating Aquilla…")
    expect(notice?.getAttribute("role")).toBe("status")
  })

  it("does not reload again for the same chunk — the loop guard", () => {
    const { reload, deps } = harness()
    recoverFromChunkError(new Error(CHROME), deps)
    reload.mockClear()
    expect(recoverFromChunkError(new Error(CHROME), deps)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it("still recovers from a SECOND deploy in the same session (a new chunk hash)", () => {
    const { reload, deps } = harness()
    recoverFromChunkError(new Error(CHROME), deps)
    reload.mockClear()
    expect(recoverFromChunkError(new Error(FIREFOX), deps)).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
  })

  it("ignores errors that are not chunk failures — a normal page never reloads itself", () => {
    const { reload, deps } = harness()
    expect(recoverFromChunkError(new Error("boom"), deps)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull()
    expect(document.getElementById(CHUNK_NOTICE_ID)).toBeNull()
  })
})

describe("showUpdatingNotice", () => {
  it("is idempotent, so a burst of failed imports paints one notice", () => {
    showUpdatingNotice(document, "Updating Aquilla…")
    showUpdatingNotice(document, "Updating Aquilla…")
    expect(document.querySelectorAll(`#${CHUNK_NOTICE_ID}`)).toHaveLength(1)
  })
})
