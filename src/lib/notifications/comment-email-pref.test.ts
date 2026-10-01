// Tests for the comment-email preference client (AQU-1193).
//
// The read-modify-write in saveCommentEmailPreference is the load-bearing part:
// PATCH /api/v2/auth/me replaces the whole preferences object, so a patch that
// sent only this key would delete every other preference on the account.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  parseCommentEmailPreference,
  fetchCommentEmailPreference,
  saveCommentEmailPreference,
  DEFAULT_COMMENT_EMAIL_PREFERENCE,
  COMMENT_EMAIL_PREFERENCE_KEY,
} from "./comment-email-pref"

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
  it("merges into the existing blob instead of replacing it", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (init?.method === "PATCH") {
        return jsonResponse({
          preferences: JSON.parse(String(init.body)).preferences as Record<string, unknown>,
        })
      }
      return jsonResponse({ preferences: { theme: "dark", translatorProfile: { age: "40" } } })
    }) as unknown as typeof fetch

    expect(await saveCommentEmailPreference("jwt", "all")).toBe("all")

    const patch = calls.find((c) => c.init?.method === "PATCH")
    expect(patch).toBeDefined()
    const sent = JSON.parse(String(patch!.init!.body)) as {
      preferences: Record<string, unknown>
    }
    // The other preferences survived the write — this is the whole point.
    expect(sent.preferences.theme).toBe("dark")
    expect(sent.preferences.translatorProfile).toEqual({ age: "40" })
    expect(sent.preferences[COMMENT_EMAIL_PREFERENCE_KEY]).toBe("all")
  })

  it("throws when the patch is rejected", async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === "PATCH" ? jsonResponse({ error: "nope" }, 500) : jsonResponse({ preferences: {} }),
    ) as unknown as typeof fetch
    await expect(saveCommentEmailPreference("jwt", "off")).rejects.toThrow("HTTP 500")
  })
})
