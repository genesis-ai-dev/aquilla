// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { googleRequest, startGoogleLogin, readGoogleAttempt, clearGoogleAttempt, saveGoogleProgress, acceptDesktopGoogleReturn } from "./google-login"
import { confirmSignupAnalyticsChoice, clearSignupAnalyticsChoice } from "../signup-analytics-choice"
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => native)
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
    await expect(startGoogleLogin("/app", false)).rejects.toThrow("storage_unavailable")
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

it("classifies start failures without changing other Google endpoint contracts", async () => {
   for (const [reply, code] of [[new Response("gateway error", {status:502}), "service_unavailable"], [new Response("limit", {status:429}), "rate_limited"]] as const) {
     vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply))
     await expect(googleRequest("start", {})).rejects.toThrow(code)
   }
   for (const [failure, code] of [[new DOMException("deadline", "TimeoutError"), "timeout"], [new TypeError("fetch failed"), "network_error"]] as const) {
     vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure))
     await expect(googleRequest("start", {})).rejects.toThrow(code)
     await expect(googleRequest("config")).rejects.toThrow("unavailable")
   }
 })

it("opens the browser and accepts only this attempt's bounded, one-use PKCE handoff", async () => {
  vi.stubGlobal("__TAURI__", {})
  native.invoke.mockResolvedValue(true)
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ desktop: true, authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?state=server-state" })))
  vi.stubGlobal("fetch", fetcher)
  await startGoogleLogin("/preferences/login-methods", false)
  const attempt = readGoogleAttempt()!
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ challenge: attempt.desktopChallenge, desktop: true })
  expect(native.invoke).toHaveBeenCalledWith("open_auth_browser", { authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=server-state" })
  const callback = `aquilla://auth/google#code=${"c".repeat(64)}&state=${attempt.desktopChallenge}`
  for (const value of [callback.replace("aquilla:", "https:"), callback.replace("state=", "state=wrong"), callback + "&token=jwt", "aquilla://auth/callback?token=jwt&refresh=r"]) expect(acceptDesktopGoogleReturn(value)).toBeNull()
  expect(acceptDesktopGoogleReturn(callback)?.get("code")).toBe("c".repeat(64))
  expect(acceptDesktopGoogleReturn(callback)).toBeNull()
  clearGoogleAttempt()
  expect(acceptDesktopGoogleReturn(callback)).toBeNull()
  await startGoogleLogin("/app", false)
  const next = readGoogleAttempt()!
  expect(acceptDesktopGoogleReturn(callback)).toBeNull()
  const cancel = `aquilla://auth/google#error=cancelled&state=${next.desktopChallenge}`
  expect(acceptDesktopGoogleReturn(cancel)?.get("error")).toBe("cancelled")
  clearGoogleAttempt()
  await startGoogleLogin("/app", false)
  const expired = `aquilla://auth/google#code=${"c".repeat(64)}&state=${readGoogleAttempt()!.desktopChallenge}`
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000)
  expect(acceptDesktopGoogleReturn(expired)).toBeNull()
})

it("does not open the browser or leave an attempt when cancelled during startup", async () => {
  vi.stubGlobal("__TAURI__", {})
  native.invoke.mockClear(); native.invoke.mockResolvedValue(true)
  const abort = new AbortController()
  const starting = startGoogleLogin("/app", false, undefined, false, abort.signal)
  abort.abort()
  await starting
  expect(readGoogleAttempt()).toBeNull()
  expect(native.invoke).not.toHaveBeenCalledWith("open_auth_browser", expect.anything())
})
