import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  login,
  signup,
  requestPasswordReset,
  submitPasswordReset,
  verifyPasswordResetToken,
  logout,
  currentJwt,
  AuthClientError,
  COOKIE_NAME,
} from "./index"

const BASE = "https://auth.test"

function jsonResponse(
  status: number,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function clearCookie() {
  // happy-dom: every cookie we set in a prior test stays unless cleared.
  if (typeof document !== "undefined") {
    for (const segment of (document.cookie || "").split(";")) {
      const eq = segment.indexOf("=")
      const name = (eq < 0 ? segment : segment.slice(0, eq)).trim()
      if (!name) continue
      document.cookie = `${name}=; Max-Age=0; Path=/`
    }
  }
}

describe("login", () => {
  beforeEach(() => {
    clearCookie()
    vi.restoreAllMocks()
  })
  afterEach(() => clearCookie())

  it("POSTs to /api/v2/auth/token with username+password", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { access_token: "jwt-1", token_type: "bearer" }),
      )
    const result = await login(
      { usernameOrEmail: "alice", password: "pw" },
      BASE,
    )
    expect(fetchSpy).toHaveBeenCalledWith(
      `${BASE}/api/v2/auth/token`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    )
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string,
    )
    expect(body).toEqual({ username: "alice", password: "pw" })
    expect(result.jwt).toBe("jwt-1")
    expect(result.username).toBe("alice")
  })

  it("writes the JWT cookie on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { access_token: "abc", token_type: "bearer" }),
    )
    await login({ usernameOrEmail: "alice", password: "pw" }, BASE)
    expect(document.cookie).toContain(`${COOKIE_NAME}=abc`)
  })

  it("throws AuthClientError on 401 with surfaced detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(401, { error: "Incorrect username/email or password" }),
    )
    let caught: unknown
    try {
      await login({ usernameOrEmail: "x", password: "y" }, BASE)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AuthClientError)
    const err = caught as AuthClientError
    expect(err.status).toBe(401)
    expect(err.message).toContain("Incorrect username/email or password")
    expect(err.detail?.error).toBe("Incorrect username/email or password")
  })

  it("AuthClientError tolerates non-JSON response bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("oops", { status: 502 }),
    )
    let caught: unknown
    try {
      await login({ usernameOrEmail: "x", password: "y" }, BASE)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AuthClientError)
    expect((caught as AuthClientError).status).toBe(502)
    expect((caught as AuthClientError).detail).toBeNull()
    expect((caught as AuthClientError).body).toBe("oops")
  })
})

describe("signup", () => {
  beforeEach(() => {
    clearCookie()
    vi.restoreAllMocks()
  })
  afterEach(() => clearCookie())

  it("POSTs to /api/v2/auth/register with username+email+password", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { access_token: "jwt-2", token_type: "bearer" }),
      )
    const result = await signup(
      { username: "bob", email: "bob@test.local", password: "pwd12345" },
      BASE,
    )
    expect(fetchSpy).toHaveBeenCalledWith(
      `${BASE}/api/v2/auth/register`,
      expect.objectContaining({ method: "POST" }),
    )
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string,
    )
    expect(body).toEqual({
      username: "bob",
      email: "bob@test.local",
      password: "pwd12345",
    })
    expect(result.jwt).toBe("jwt-2")
  })

  it("throws AuthClientError on 409 user-already-exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, { detail: "User already exists", error: "User already exists" }),
    )
    await expect(
      signup({ username: "x", email: "x@y", password: "z" }, BASE),
    ).rejects.toBeInstanceOf(AuthClientError)
  })

  it("writes the JWT cookie on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { access_token: "sj", token_type: "bearer" }),
    )
    await signup(
      { username: "bob", email: "b@b", password: "pwd12345" },
      BASE,
    )
    expect(document.cookie).toContain(`${COOKIE_NAME}=sj`)
  })
})

describe("requestPasswordReset", () => {
  beforeEach(() => {
    clearCookie()
    vi.restoreAllMocks()
  })

  it("POSTs to /api/v2/auth/password-reset/request with the email", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { message: "ok" }))
    await requestPasswordReset("alice@test.local", BASE)
    expect(fetchSpy).toHaveBeenCalledWith(
      `${BASE}/api/v2/auth/password-reset/request`,
      expect.objectContaining({ method: "POST" }),
    )
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string,
    )
    expect(body).toEqual({ email: "alice@test.local" })
  })

  it("surfaces 5xx as AuthClientError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(500, { error: "boom" }),
    )
    await expect(
      requestPasswordReset("a@b", BASE),
    ).rejects.toBeInstanceOf(AuthClientError)
  })
})

describe("submitPasswordReset", () => {
  beforeEach(() => {
    clearCookie()
    vi.restoreAllMocks()
  })

  it("POSTs to /password-reset/reset with snake_case body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { message: "ok" }))
    await submitPasswordReset(
      { token: "tok", username: "alice", newPassword: "newpw1234" },
      BASE,
    )
    expect(fetchSpy).toHaveBeenCalledWith(
      `${BASE}/api/v2/auth/password-reset/reset`,
      expect.objectContaining({ method: "POST" }),
    )
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string,
    )
    expect(body).toEqual({
      token: "tok",
      username: "alice",
      new_password: "newpw1234",
    })
  })

  it("throws on 400 invalid-token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(400, { error: "Invalid token" }),
    )
    await expect(
      submitPasswordReset(
        { token: "x", username: "y", newPassword: "longenoughpw" },
        BASE,
      ),
    ).rejects.toBeInstanceOf(AuthClientError)
  })
})

describe("verifyPasswordResetToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("returns true on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { message: "ok" }),
    )
    await expect(
      verifyPasswordResetToken({ token: "t", username: "u" }, BASE),
    ).resolves.toBe(true)
  })

  it("returns false on 400 invalid token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(400, { error: "Invalid token" }),
    )
    await expect(
      verifyPasswordResetToken({ token: "t", username: "u" }, BASE),
    ).resolves.toBe(false)
  })

  it("throws on 5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(503, { error: "down" }),
    )
    await expect(
      verifyPasswordResetToken({ token: "t", username: "u" }, BASE),
    ).rejects.toBeInstanceOf(AuthClientError)
  })
})

describe("logout + currentJwt", () => {
  beforeEach(() => {
    clearCookie()
    vi.restoreAllMocks()
  })

  it("logout clears the cookie", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { access_token: "j", token_type: "bearer" }),
    )
    await login({ usernameOrEmail: "a", password: "b" }, BASE)
    expect(currentJwt()).toBe("j")
    logout()
    expect(currentJwt()).toBeNull()
  })
})
