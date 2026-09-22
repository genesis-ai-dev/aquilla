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

// WHY: the nightly sync died for weeks with a bare "401 Unauthorized". The
// resolver must (a) prefer the direct token when both credential sets are set
// — so an expired FRONTIER_TOKEN shadows a valid username/password, which the
// operator needs to know — and (b) tag which path produced the creds so the
// failure names the secret to rotate.
import { resolveCredentialsFromEnv, describeCredentialSource } from "./auth"

describe("resolveCredentialsFromEnv", () => {
  it("uses FRONTIER_TOKEN + GITLAB_URL directly and tags the source", async () => {
    const creds = await resolveCredentialsFromEnv({ FRONTIER_TOKEN: " tok ", GITLAB_URL: "https://git.example.com/" })
    expect(creds).toEqual({ gitlabToken: "tok", gitlabUrl: "https://git.example.com", accessToken: "", source: "direct-token" })
  })

  it("prefers the direct token over username/password when both are set", async () => {
    const creds = await resolveCredentialsFromEnv({
      FRONTIER_TOKEN: "tok",
      GITLAB_URL: "https://git.example.com",
      FRONTIER_USERNAME: "u",
      FRONTIER_PASSWORD: "p",
    })
    expect(creds.source).toBe("direct-token")
  })

  it("throws an actionable message when nothing is set", async () => {
    await expect(resolveCredentialsFromEnv({})).rejects.toThrow(/FRONTIER_USERNAME \+ FRONTIER_PASSWORD/)
  })

  it("describes each source by its env vars", () => {
    expect(describeCredentialSource("direct-token")).toMatch(/FRONTIER_TOKEN \+ GITLAB_URL/)
    expect(describeCredentialSource("frontier-login")).toMatch(/FRONTIER_USERNAME \+ FRONTIER_PASSWORD/)
    expect(describeCredentialSource(undefined)).toBe("unknown credential path")
  })
})
