import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"

const originalFetch = global.fetch

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

function d1Response(results: Array<{ id: number }>): Response {
  return jsonResponse({
    success: true,
    result: [{ success: true, results }],
  })
}

function registrationEnv(
  overrides: Record<string, unknown> = {},
) {
  return {
    ...env,
    LEGACY_USER_MIGRATION_ENABLED: "true",
    FRONTIER_D1_ACCOUNT_ID: "account",
    FRONTIER_D1_DATABASE_ID: "database",
    FRONTIER_D1_API_TOKEN: "d1-read-token",
    ...overrides,
  }
}

async function register(
  username: string,
  email: string,
  requestEnv = registrationEnv(),
): Promise<Response> {
  return app.request(
    "/api/v2/auth/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        email,
        password: "very-secure",
      }),
    },
    requestEnv,
  )
}

function installD1Result(
  result:
    | Array<{ id: number }>
    | ((request: { sql: string; params: string[] }) => Array<{ id: number }>),
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    expect(String(input)).toContain(
      "/accounts/account/d1/database/database/query",
    )
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer d1-read-token",
    })
    const request = JSON.parse(String(init?.body)) as {
      sql: string
      params: string[]
    }
    expect(request.sql).toContain("LOWER(username) = LOWER(?)")
    expect(request.sql).toContain("LOWER(email) = LOWER(?)")
    expect(request.sql).not.toContain("password_hash")
    expect(request.sql).not.toContain("gitlab_token")
    return d1Response(typeof result === "function" ? result(request) : result)
  })
  global.fetch = fetchMock as typeof fetch
  return fetchMock
}

async function expectNoUser(username: string): Promise<void> {
  expect(await env.AQUILLA_PG.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE LOWER(username) = LOWER(?)",
  ).bind(username).first<number>("n")).toBe(0)
}

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe("legacy identity reservation during registration", () => {
  it("rejects a username that exists in D1 with the generic duplicate response", async () => {
    const fetchMock = installD1Result([{ id: 700 }])

    const response = await register("Cleiton", "new-address@example.com")

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      detail: "User already exists",
      error: "User already exists",
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const request = JSON.parse(String(
      fetchMock.mock.calls[0][1]?.body,
    )) as { params: string[] }
    expect(request.params).toEqual(["Cleiton", "new-address@example.com"])
    await expectNoUser("Cleiton")
  })

  it("rejects an email that exists in D1 with the same generic response", async () => {
    const fetchMock = installD1Result([{ id: 700 }])

    const response = await register("new-cleiton", "cleiton@example.com")

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      detail: "User already exists",
      error: "User already exists",
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    await expectNoUser("new-cleiton")
  })

  it("uses case-insensitive D1 comparisons for username and email", async () => {
    const fetchMock = installD1Result([{ id: 700 }])

    const response = await register("cLeItOn", "CLEITON@EXAMPLE.COM")

    expect(response.status).toBe(409)
    const request = JSON.parse(String(
      fetchMock.mock.calls[0][1]?.body,
    )) as { sql: string; params: string[] }
    expect(request.sql).toMatch(
      /LOWER\(username\) = LOWER\(\?\).*LOWER\(email\) = LOWER\(\?\)/s,
    )
    expect(request.params).toEqual(["cLeItOn", "CLEITON@EXAMPLE.COM"])
    await expectNoUser("cleiton")
  })

  it("rejects a split identity when username and email belong to different D1 users", async () => {
    const legacyUsers = [
      {
        id: 700,
        username: "legacy-one",
        email: "legacy-one@example.com",
      },
      {
        id: 701,
        username: "legacy-two",
        email: "legacy-two@example.com",
      },
    ]
    const fetchMock = installD1Result(({ params }) => {
      const [username, email] = params.map((value) => value.toLowerCase())
      const matches = legacyUsers.filter((user) =>
        user.username.toLowerCase() === username ||
        user.email.toLowerCase() === email
      )
      expect(matches.map(({ id }) => id)).toEqual([700, 701])
      // The real query uses LIMIT 1 because either collision is sufficient.
      return matches.slice(0, 1).map(({ id }) => ({ id }))
    })

    const response = await register("legacy-one", "legacy-two@example.com")

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      detail: "User already exists",
      error: "User already exists",
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    await expectNoUser("legacy-one")
  })

  it("fails closed with a retryable response when D1 is unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    global.fetch = vi.fn(async () => {
      throw new Error("network unavailable")
    }) as typeof fetch

    const response = await register("safe-new-user", "safe-new@example.com")

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      detail: "Registration is temporarily unavailable. Please try again.",
      error: "Registration temporarily unavailable",
    })
    expect(errorSpy).toHaveBeenCalledWith(
      "[legacy-user-migration] registration identity check unavailable",
    )
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("safe-new-user")
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      "safe-new@example.com",
    )
    await expectNoUser("safe-new-user")
  })

  it("fails closed when the bridge is enabled without complete D1 configuration", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const fetchMock = vi.fn()
    global.fetch = fetchMock as typeof fetch

    const response = await register(
      "misconfigured-user",
      "misconfigured@example.com",
      registrationEnv({ FRONTIER_D1_API_TOKEN: "" }),
    )

    expect(response.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      "[legacy-user-migration] registration identity check unavailable",
    )
    await expectNoUser("misconfigured-user")
  })

  it("registers an ordinary nonlegacy user after D1 confirms no collision", async () => {
    const fetchMock = installD1Result([])

    const response = await register("ordinary-user", "ordinary@example.com")

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ token_type: "bearer" })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await env.AQUILLA_PG.prepare(
      "SELECT email FROM users WHERE username = ?",
    ).bind("ordinary-user").first<string>("email")).toBe(
      "ordinary@example.com",
    )
  })

  it("does not require D1 when legacy migration is disabled", async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as typeof fetch

    const response = await register(
      "bridge-disabled",
      "bridge-disabled@example.com",
      registrationEnv({ LEGACY_USER_MIGRATION_ENABLED: "false" }),
    )

    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
