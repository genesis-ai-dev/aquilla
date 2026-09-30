// Pure-helper tests for the auth layer. The only pure surface is URL
// normalization (trimTrailingSlash), which matters because every GitLab /
// git / LFS URL is built by string-concatenating onto gitlabUrl — a stray
// trailing slash would produce "//api/v4/..." and 404s. The network-bound
// login/resolve paths are exercised live (they require real Frontier creds,
// documented at the top of scripts/migrate-fetch.ts).

import { describe, it, expect, vi } from "vitest"
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
// resolver must (a) try the direct token first when both credential sets are
// set, (b) VERIFY it rather than assume it, so an expired FRONTIER_TOKEN falls
// through to a valid username/password instead of shadowing it (AQU-1347 —
// this is the 60-run silent failure in AQU-1344), and (c) tag which path
// produced the creds so the failure names the secret to rotate.
import {
  resolveCredentialsFromEnv,
  describeCredentialSource,
  verifyGitLabToken,
  type CredentialCheck,
  type GitLabCredentials,
} from "./auth"

/** A verifier that says yes, and records what it was asked about. */
function accepting(seen: GitLabCredentials[] = []) {
  return async (creds: GitLabCredentials): Promise<CredentialCheck> => {
    seen.push(creds)
    return { ok: true }
  }
}

/** A verifier that rejects the way an expired token does. */
const rejecting = async (): Promise<CredentialCheck> => ({
  ok: false,
  reason: "401 Unauthorized",
})

describe("resolveCredentialsFromEnv", () => {
  it("uses FRONTIER_TOKEN + GITLAB_URL directly when GitLab accepts it", async () => {
    const creds = await resolveCredentialsFromEnv(
      { FRONTIER_TOKEN: " tok ", GITLAB_URL: "https://git.example.com/" },
      { verify: accepting(), log: () => {} },
    )
    expect(creds).toEqual({ gitlabToken: "tok", gitlabUrl: "https://git.example.com", accessToken: "", source: "direct-token" })
  })

  it("tries the direct token before username/password when both are set", async () => {
    const creds = await resolveCredentialsFromEnv(
      {
        FRONTIER_TOKEN: "tok",
        GITLAB_URL: "https://git.example.com",
        FRONTIER_USERNAME: "u",
        FRONTIER_PASSWORD: "p",
      },
      { verify: accepting(), log: () => {} },
    )
    expect(creds.source).toBe("direct-token")
  })

  it("names the path it used, so a log says which secret is live", async () => {
    const lines: string[] = []
    await resolveCredentialsFromEnv(
      { FRONTIER_TOKEN: "tok", GITLAB_URL: "https://git.example.com" },
      { verify: accepting(), log: (m) => lines.push(m) },
    )
    expect(lines.join("\n")).toMatch(/FRONTIER_TOKEN \+ GITLAB_URL/)
  })

  // The regression this ticket exists for: a dead direct token must not take
  // the whole run down with it while a working password grant sits beside it.
  it("falls through to the password grant when GitLab rejects the direct token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "a", gitlab_token: "brokered", gitlab_url: "https://git.example.com/" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const lines: string[] = []
    try {
      const creds = await resolveCredentialsFromEnv(
        {
          FRONTIER_TOKEN: "expired",
          GITLAB_URL: "https://git.example.com",
          FRONTIER_USERNAME: "u",
          FRONTIER_PASSWORD: "p",
        },
        { verify: rejecting, log: (m) => lines.push(m) },
      )
      expect(creds.source).toBe("frontier-login")
      expect(creds.gitlabToken).toBe("brokered")
    } finally {
      vi.unstubAllGlobals()
    }
    const log = lines.join("\n")
    expect(log).toMatch(/FRONTIER_TOKEN was rejected by GitLab \(401 Unauthorized\)/)
    expect(log).toMatch(/falling back to the FRONTIER_USERNAME \+ FRONTIER_PASSWORD/)
    expect(log).not.toMatch(/expired/)
  })

  it("refuses, naming the secret to rotate, when the direct token is dead and there is no fallback", async () => {
    await expect(
      resolveCredentialsFromEnv(
        { FRONTIER_TOKEN: "expired", GITLAB_URL: "https://git.example.com" },
        { verify: rejecting, log: () => {} },
      ),
    ).rejects.toThrow(/Rotate FRONTIER_TOKEN/)
  })

  it("names BOTH failures, and no secret values, when every path fails", async () => {
    const fetchMock = vi.fn(async () => new Response("bad creds", { status: 401, statusText: "Unauthorized" }))
    vi.stubGlobal("fetch", fetchMock)
    try {
      await expect(
        resolveCredentialsFromEnv(
          {
            FRONTIER_TOKEN: "expired-token-value",
            GITLAB_URL: "https://git.example.com",
            FRONTIER_USERNAME: "u",
            FRONTIER_PASSWORD: "secret-password-value",
          },
          { verify: rejecting, log: () => {} },
        ),
      ).rejects.toThrow(
        /Both GitLab credential paths failed.*FRONTIER_TOKEN was rejected.*password grant also failed/s,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("keeps the plain password-grant error when no direct token was set", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401, statusText: "Unauthorized" }))
    vi.stubGlobal("fetch", fetchMock)
    try {
      await expect(
        resolveCredentialsFromEnv(
          { FRONTIER_USERNAME: "u", FRONTIER_PASSWORD: "p" },
          { log: () => {} },
        ),
      ).rejects.toThrow(/Check FRONTIER_USERNAME \/ FRONTIER_PASSWORD/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("ignores a half-set direct pair and goes straight to the password grant", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "a", gitlab_token: "brokered", gitlab_url: "https://git.example.com" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const verify = vi.fn(async (): Promise<CredentialCheck> => ({ ok: true }))
    try {
      const creds = await resolveCredentialsFromEnv(
        { FRONTIER_TOKEN: "tok", FRONTIER_USERNAME: "u", FRONTIER_PASSWORD: "p" },
        { verify, log: () => {} },
      )
      expect(creds.source).toBe("frontier-login")
      expect(verify).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("throws an actionable message when nothing is set", async () => {
    await expect(resolveCredentialsFromEnv({}, { log: () => {} })).rejects.toThrow(/FRONTIER_USERNAME \+ FRONTIER_PASSWORD/)
  })

  it("describes each source by its env vars", () => {
    expect(describeCredentialSource("direct-token")).toMatch(/FRONTIER_TOKEN \+ GITLAB_URL/)
    expect(describeCredentialSource("frontier-login")).toMatch(/FRONTIER_USERNAME \+ FRONTIER_PASSWORD/)
    expect(describeCredentialSource(undefined)).toBe("unknown credential path")
  })
})

describe("verifyGitLabToken", () => {
  const creds: GitLabCredentials = {
    gitlabToken: "tok",
    gitlabUrl: "https://git.example.com/",
    accessToken: "",
  }

  it("asks the cheapest authenticated endpoint, with the token as a bearer", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    const check = await verifyGitLabToken(creds, fetchMock as unknown as typeof fetch)
    expect(check.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith("https://git.example.com/api/v4/user", {
      headers: { Authorization: "Bearer tok" },
    })
  })

  it("reports the status line — not the token — when GitLab refuses", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 401, statusText: "Unauthorized" }))
    const check = await verifyGitLabToken(creds, fetchMock as unknown as typeof fetch)
    expect(check).toEqual({ ok: false, reason: "401 Unauthorized" })
  })

  it("reports an unreachable GitLab as a failure rather than throwing", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    })
    const check = await verifyGitLabToken(creds, fetchMock as unknown as typeof fetch)
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/could not reach https:\/\/git\.example\.com\/api\/v4\/user: ECONNREFUSED/)
  })
})
