// Unit tests for scoped-search.ts helpers.
//
// sanitizeFtsQuery tests already live in search-read.test.ts; we don't
// duplicate them here. This file covers:
//   - sanitizeFtsExactPhrase (new in Step 5)
//   - makeVerifiedProjectId (functional smoke-test; structural guarantee is
//     enforced by the TypeScript compiler at compile time, not at runtime)

import { describe, it, expect } from "vitest"
import {
  sanitizeFtsExactPhrase,
  makeVerifiedProjectId,
} from "../events/scoped-search"
import type { SyncTokenClaims } from "../auth"

// ---------------------------------------------------------------------------
// sanitizeFtsExactPhrase
// ---------------------------------------------------------------------------

describe("sanitizeFtsExactPhrase", () => {
  it("returns null for an empty string", () => {
    expect(sanitizeFtsExactPhrase("")).toBeNull()
  })

  it("returns null for a string that is purely punctuation", () => {
    expect(sanitizeFtsExactPhrase('"*()')).toBeNull()
    expect(sanitizeFtsExactPhrase("()")).toBeNull()
  })

  it("returns null when all tokens are FTS reserved keywords", () => {
    expect(sanitizeFtsExactPhrase("AND OR NOT NEAR")).toBeNull()
    expect(sanitizeFtsExactPhrase("and or")).toBeNull()
  })

  it("wraps a single token in double quotes", () => {
    expect(sanitizeFtsExactPhrase("hello")).toBe('"hello"')
  })

  it("wraps multiple tokens as a single double-quoted phrase", () => {
    // All tokens joined inside one pair of double quotes (ordered phrase match).
    expect(sanitizeFtsExactPhrase("hello world")).toBe('"hello world"')
    expect(sanitizeFtsExactPhrase("In the beginning")).toBe('"In the beginning"')
  })

  it("strips FTS reserved keywords from the phrase", () => {
    // "AND" is reserved; "foo" and "bar" survive.
    expect(sanitizeFtsExactPhrase("foo AND bar")).toBe('"foo bar"')
    expect(sanitizeFtsExactPhrase("alpha OR NOT NEAR omega")).toBe('"alpha omega"')
  })

  it("strips punctuation characters that confuse the FTS parser", () => {
    // Quotes, parens, colons, asterisks become spaces; surviving tokens are joined.
    expect(sanitizeFtsExactPhrase('"hello" (world)')).toBe('"hello world"')
    expect(sanitizeFtsExactPhrase("col:on")).toBe('"col on"')
  })

  it("differs from sanitizeFtsQuery: emits one phrase, not per-token quotes", () => {
    // sanitizeFtsQuery("hello world") → '"hello" "world"' (two quoted tokens)
    // sanitizeFtsExactPhrase("hello world") → '"hello world"' (one quoted phrase)
    const phrase = sanitizeFtsExactPhrase("hello world")
    expect(phrase).toBe('"hello world"')
    // There must be exactly one pair of double quotes.
    expect((phrase!.match(/"/g) ?? []).length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// makeVerifiedProjectId
// ---------------------------------------------------------------------------

describe("makeVerifiedProjectId", () => {
  it("returns the projectId from the claims", () => {
    const claims: SyncTokenClaims = {
      userId: 42,
      username: "alice",
      projectId: "proj-xyz",
      fileId: "file-1",
      role: 400,
      aud: "sync",
      iat: 1000,
      exp: 9999,
    }
    expect(makeVerifiedProjectId(claims)).toBe("proj-xyz")
  })

  it("is identity: the returned value equals claims.projectId", () => {
    const claims: SyncTokenClaims = {
      userId: 1,
      username: "bob",
      projectId: "my-project",
      fileId: "f1",
      role: 100,
      aud: "sync",
      iat: 0,
      exp: 99999,
    }
    const vid = makeVerifiedProjectId(claims)
    expect(vid).toBe(claims.projectId)
  })
})
