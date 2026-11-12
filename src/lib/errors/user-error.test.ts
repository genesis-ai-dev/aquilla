// Unit tests for the network error taxonomy (AQU-281).
//
// Verifies that:
//  1. Status codes map to human messages, not "HTTP NNN" strings.
//  2. Offline / network-failure detection works.
//  3. toUserFacingError correctly parses the "...failed: HTTP NNN — body" pattern
//     thrown by our fetch helpers.
//  4. UserError carries technical detail in .cause, never as .message.

import { describe, it, expect, afterEach } from "vitest"
import {
  ERROR_CONTEXT_NOUNS,
  messageForStatus,
  isNetworkFailure,
  toUserFacingError,
  UserError,
  type ErrorContext,
  type NetworkErrorCategory,
} from "./user-error"
// Side effect: installs every locale catalog synchronously, so the assertions
// below see translated text rather than the English fallback (AQU-1991).
import { CATALOGS } from "@/test-utils/all-catalogs"
import { en, type MessageKey } from "@/lib/i18n/messages/en"
import { CATALOG_LOCALES, answerFromCatalogsForTests } from "@/lib/i18n/messages"
import { translate } from "@/lib/i18n/translate"
import { LOCALE_STORAGE_KEY } from "@/lib/i18n/store"

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
    const result = messageForStatus(404, "", "project")
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

// AQU-1352 §3.9 rule 2: a role-gated 403 names the viewer's role, its origin,
// and the required role — so "no permission" is actionable. Without the
// structure the generic copy must still stand (older servers, other 403s).
describe("messageForStatus 403 role_required", () => {
  const body = (actual: Record<string, unknown>) =>
    JSON.stringify({ error: "maintainer+ required", code: "role_required", required: { roleLevel: 600 }, actual })

  it("names role, origin and required role", () => {
    const r = messageForStatus(403, body({ roleLevel: 400, source: "group" }))
    expect(r.category).toBe("forbidden")
    expect(r.message).toBe("You are Contributor here (Via group). Maintainer is required.")
  })

  it("never renders a numeric level", () => {
    const r = messageForStatus(403, body({ roleLevel: 400, source: "org" }))
    expect(r.message).not.toMatch(/\d/)
  })

  it("handles a caller with no role", () => {
    expect(messageForStatus(403, body({ roleLevel: null, source: null })).message).toBe(
      "You don't have a role here. Maintainer is required.",
    )
  })

  it("falls back to the generic copy for an unstructured 403", () => {
    const r = messageForStatus(403, JSON.stringify({ error: "nope" }))
    expect(r.message).toBe("You don't have permission to do that.")
  })
})

// ─── AQU-1821: the context noun is translated, or the clause is dropped ──────
//
// `context` used to be a free `string` and every caller passed a bare English
// word, which `error.network.contextSuffix` interpolated verbatim. The frame
// was translated and the noun was not, so a Burmese 403 read
// "ဤအရာကို ပြုလုပ်ရန် ခွင့်ပြုချက် မရှိပါ ဤteam အတွက်။" — one sentence, two
// languages. The contract now: a context is a KEY into the catalogues, and the
// whole clause is dropped when this locale has no translation for that noun
// (a machine translation is ruled out by locales.ts / AQU-1306).
//
// The compile-time half of the guard is `ERROR_CONTEXT_NOUNS` itself: a caller
// writing `toUserFacingError(e, "organization members")` no longer builds.

describe("AQU-1821: localized context noun", () => {
  const CONTEXTS = Object.keys(ERROR_CONTEXT_NOUNS) as ErrorContext[]
  const FRAMES = [
    "error.network.badRequest",
    "error.network.forbidden",
    "error.network.notFound",
    "error.network.conflict",
    "error.network.gone",
  ] as const satisfies readonly MessageKey[]
  const STATUS_OF_FRAME = { 400: 0, 403: 1, 404: 2, 409: 3, 410: 4 } as const

  const setLocale = (code: string) => window.localStorage.setItem(LOCALE_STORAGE_KEY, code)

  afterEach(() => {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY)
  })

  it("every context names a key the English catalogue actually carries", () => {
    for (const context of CONTEXTS) {
      const value = en[ERROR_CONTEXT_NOUNS[context]]
      expect(typeof value === "string" && value.trim().length > 0).toBe(true)
    }
  })

  it("renders the reported Burmese 403 with no Latin letters at all", () => {
    setLocale("my")
    // The exact repro: a team role change denied on /org/[slug] → Teams.
    const message = toUserFacingError(new Error("HTTP 403"), "team").message
    expect(message).not.toMatch(/[A-Za-z]/)
    expect(message).toContain(CATALOGS.my["org.access.scope.team"] as string)
    expect(message).toBe(
      translate(
        CATALOGS.my,
        "error.network.forbidden",
        {
          contextSuffix: translate(
            CATALOGS.my,
            "error.network.contextSuffix",
            { context: CATALOGS.my["org.access.scope.team"] as string },
            "my",
          ),
        },
        "my",
      ),
    )
  })

  it("drops the whole clause when this locale has no word for the noun", () => {
    setLocale("my")
    // `error.network.context.invite` is new, so no catalogue translates it yet.
    expect(CATALOGS.my["error.network.context.invite"]).toBeUndefined()

    const withContext = toUserFacingError(new Error("HTTP 404"), "invite").message
    const withNone = toUserFacingError(new Error("HTTP 404")).message
    expect(withContext).toBe(withNone)
    expect(withContext).not.toMatch(/[A-Za-z]/)
    expect(withContext).not.toContain("invite")
  })

  it("drops the clause when the locale has the noun but not the frame around it", () => {
    // The other half of the same rule. A locale that translated the word but
    // not " for this {context}" would otherwise read "… for this ပရောဂျက်" —
    // the mirror image of the reported bug.
    const { ["error.network.contextSuffix"]: _frame, ...myWithoutFrame } = CATALOGS.my
    answerFromCatalogsForTests({ ...CATALOGS, my: myWithoutFrame })
    try {
      setLocale("my")
      expect(messageForStatus(403, "", "project").message).toBe(
        messageForStatus(403, "").message,
      )
    } finally {
      answerFromCatalogsForTests(CATALOGS)
    }
  })

  it("keeps the clause in English, where every noun is by definition translated", () => {
    setLocale("en")
    for (const context of CONTEXTS) {
      const message = messageForStatus(403, "", context).message
      expect(message).toContain(en[ERROR_CONTEXT_NOUNS[context]] as string)
    }
  })

  // The locale-complete half of AC#1. Script-agnostic on purpose: in Spanish
  // the clause SHOULD add Latin letters. What may never happen, in any locale,
  // is a clause whose text the locale's own catalogue did not supply.
  it.each(CATALOG_LOCALES)("%s renders a clause only out of its own catalogue", (locale) => {
    setLocale(locale)
    const catalog = CATALOGS[locale]
    for (const context of CONTEXTS) {
      for (const [status, frameIndex] of Object.entries(STATUS_OF_FRAME)) {
        const frame = FRAMES[frameIndex]
        const message = messageForStatus(Number(status), "", context).message
        const bare = translate(catalog, frame, { contextSuffix: "" }, locale)
        if (message === bare) continue // clause dropped — always allowed
        // A clause appeared, so this locale owns both halves of it.
        expect(catalog["error.network.contextSuffix"], `${locale} ${frame}`).toBeDefined()
        expect(catalog[ERROR_CONTEXT_NOUNS[context]], `${locale} ${context}`).toBeDefined()
        expect(message).toContain(catalog[ERROR_CONTEXT_NOUNS[context]] as string)
      }
    }
  })
})
