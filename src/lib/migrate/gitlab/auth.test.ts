// Pure-helper tests for the auth layer. The only pure surface is URL
// normalization (trimTrailingSlash), which matters because every GitLab /
// git / LFS URL is built by string-concatenating onto gitlabUrl — a stray
// trailing slash would produce "//api/v4/..." and 404s. The network-bound
// login/resolve paths are exercised live (they require real Frontier creds,
// documented at the top of scripts/migrate-fetch.ts).

import { describe, it, expect } from "vitest"
import { trimTrailingSlash, DEFAULT_FRONTIER_API } from "./auth"

describe("trimTrailingSlash", () => {
  it("strips a single trailing slash", () => {
    expect(trimTrailingSlash("https://gitlab.example.com/")).toBe(
      "https://gitlab.example.com",
    )
  })

  it("strips multiple trailing slashes", () => {
    expect(trimTrailingSlash("https://gitlab.example.com///")).toBe(
      "https://gitlab.example.com",
    )
  })

  it("leaves a slash-free URL untouched", () => {
    expect(trimTrailingSlash("https://gitlab.example.com")).toBe(
      "https://gitlab.example.com",
    )
  })

  it("does not strip a slash that is part of the path body", () => {
    expect(trimTrailingSlash("https://host/api/v1")).toBe("https://host/api/v1")
  })
})

describe("DEFAULT_FRONTIER_API", () => {
  it("points at the production Frontier API v1 with no trailing slash", () => {
    expect(DEFAULT_FRONTIER_API).toBe("https://api.frontierrnd.com/api/v1")
    expect(DEFAULT_FRONTIER_API.endsWith("/")).toBe(false)
  })
})
