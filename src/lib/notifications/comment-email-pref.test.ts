// Tests for the comment-email preference client (AQU-1193).
//
// The save must keep every other preference on the account, including one
// another device writes while it saves (AQU-2264: it sends only its own key to
// PATCH /api/v2/auth/me/preferences, which merges).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  parseCommentEmailPreference,
  fetchCommentEmailPreference,
  saveCommentEmailPreference,
  DEFAULT_COMMENT_EMAIL_PREFERENCE,
  COMMENT_EMAIL_PREFERENCE_KEY,
} from "./comment-email-pref"
import { createFakePreferencesServer } from "@/test-utils/fake-preferences-server"

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("parseCommentEmailPreference", () => {
  it("accepts the three known values", () => {
    expect(parseCommentEmailPreference("all")).toBe("all")
    expect(parseCommentEmailPreference("mentions")).toBe("mentions")
    expect(parseCommentEmailPreference("off")).toBe("off")
  })

  it("defaults on anything else", () => {
    expect(parseCommentEmailPreference(undefined)).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
    expect(parseCommentEmailPreference(null)).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
    expect(parseCommentEmailPreference("loud")).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
    expect(parseCommentEmailPreference(7)).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
  })

  it("agrees with the worker's default — mention-only", () => {
    expect(DEFAULT_COMMENT_EMAIL_PREFERENCE).toBe("mentions")
  })
})

describe("fetchCommentEmailPreference", () => {
  it("reads the key out of the preferences blob", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ preferences: { [COMMENT_EMAIL_PREFERENCE_KEY]: "off" } }),
    ) as unknown as typeof fetch
    expect(await fetchCommentEmailPreference("jwt")).toBe("off")
  })

  it("defaults when the account has never set one", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ preferences: { theme: "dark" } }),
    ) as unknown as typeof fetch
    expect(await fetchCommentEmailPreference("jwt")).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
  })

  it("defaults when the response carries no preferences object at all", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch
    expect(await fetchCommentEmailPreference("jwt")).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
  })

  it("throws on a non-OK response", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: "nope" }, 401),
    ) as unknown as typeof fetch
    await expect(fetchCommentEmailPreference("jwt")).rejects.toThrow("HTTP 401")
  })
})

describe("saveCommentEmailPreference", () => {
  it("keeps every other preference on the account", async () => {
    const server = createFakePreferencesServer({ theme: "dark", translatorProfile: { age: "40" } })
    globalThis.fetch = server.fetch

    expect(await saveCommentEmailPreference("jwt", "all")).toBe("all")

    expect(server.record).toEqual({
      theme: "dark",
      translatorProfile: { age: "40" },
      [COMMENT_EMAIL_PREFERENCE_KEY]: "all",
    })
  })

  // AQU-2264: the old save read the whole record, changed this key and sent
  // the whole record back (PATCH /auth/me replaces it). A write from another
  // device between that read and that write was silently undone.
  it("does not undo another device's write that lands while it saves", async () => {
    const server = createFakePreferencesServer({ theme: "dark" })
    globalThis.fetch = server.fetch
    // The recorder on another device saves just before this write arrives.
    server.beforeWrite = () => {
      server.beforeWrite = null
      server.record = { ...server.record, "recorder.countdown": "fast" }
    }

    await saveCommentEmailPreference("jwt", "off")

    expect(server.record).toEqual({
      theme: "dark",
      "recorder.countdown": "fast",
      [COMMENT_EMAIL_PREFERENCE_KEY]: "off",
    })
  })

  it("throws when the save is refused", async () => {
    const server = createFakePreferencesServer({})
    globalThis.fetch = server.fetch
    server.failWith = 500
    await expect(saveCommentEmailPreference("jwt", "off")).rejects.toThrow("HTTP 500")
  })
})
