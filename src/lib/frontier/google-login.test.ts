// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { googleRequest, startGoogleLogin, readGoogleAttempt, clearGoogleAttempt, saveGoogleProgress } from "./google-login"
import { confirmSignupAnalyticsChoice, clearSignupAnalyticsChoice } from "../signup-analytics-choice"
beforeEach(() => { sessionStorage.clear(); clearSignupAnalyticsChoice(); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it("distinguishes invalid sessions from incorrect Google-link password proofs", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({error:"Unauthorized"},{status:401})))
  await expect(googleRequest("methods",undefined,"expired-jwt")).rejects.toThrow("session_expired")
  await expect(googleRequest("disconnect",{password:"incorrect"},"valid-jwt")).rejects.toThrow("Unauthorized")
})
describe("Google login intent", () => {
  it("does not fetch on import or reading state; fails before provider contact when storage is denied or offline", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher)
    expect(readGoogleAttempt()).toBeNull(); clearGoogleAttempt()
    expect(fetcher).not.toHaveBeenCalled()
    vi.spyOn(sessionStorage, "setItem").mockImplementationOnce(() => { throw new Error("denied") })
    await expect(startGoogleLogin("/app", false)).rejects.toThrow("denied")
    expect(fetcher).not.toHaveBeenCalled()
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    await expect(startGoogleLogin("/app", false)).rejects.toThrow("offline")
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("binds an explicit signup choice to its attempt and sends only a challenge to the first-party start endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ authorization_url: "https://wrong.example" }))
    vi.stubGlobal("fetch", fetcher)
    confirmSignupAnalyticsChoice(true)
    await expect(startGoogleLogin("/join/project-token", true)).rejects.toThrow("invalid_request")
    const attempt = readGoogleAttempt()!
    expect(attempt.next).toBe("/join/project-token")
    expect(attempt.choice?.allowed).toBe(true)
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toMatch(/\/api\/v2\/auth\/oauth\/google\/start$/)
    expect(options.credentials).toBe("omit")
    expect(Object.keys(JSON.parse(options.body))).toEqual(["challenge"])
    expect(options.body).not.toContain(attempt.verifier)
    await expect(startGoogleLogin("//evil.example", false)).rejects.toThrow()
    expect(readGoogleAttempt()).toMatchObject({ next: "/app", choice: null })
  })
  it("caps requests and reports first-party failure without falling back to Google scripts", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 })); vi.stubGlobal("fetch", fetcher)
    await expect(googleRequest("config")).rejects.toThrow("unavailable")
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(document.querySelector('script[src*="google"]')).toBeNull()
  })
})

it("keeps only a bounded tab-local continuation, preserving consent across reload without provider contact", async () => {
  const fetcher=vi.fn().mockResolvedValue(Response.json({authorization_url:"https://wrong.example"}));vi.stubGlobal("fetch",fetcher)
  confirmSignupAnalyticsChoice(false)
  await expect(startGoogleLogin("/app",true)).rejects.toThrow("invalid_request")
  const attempt=readGoogleAttempt()!
  const pending={continuation:"c".repeat(64),step:"signup" as const,email:"alice@example.com"}
  saveGoogleProgress(attempt.verifier,{pending})
  expect(readGoogleAttempt()).toMatchObject({pending,choice:{allowed:false}})
  expect(fetcher).toHaveBeenCalledOnce()
  expect(()=>saveGoogleProgress("b".repeat(64),{pending})).toThrow("expired_request")
  const expires=readGoogleAttempt()!.expires
  vi.spyOn(Date,"now").mockReturnValue(expires+1)
  expect(readGoogleAttempt()).toBeNull()
  expect(fetcher).toHaveBeenCalledOnce()
})
