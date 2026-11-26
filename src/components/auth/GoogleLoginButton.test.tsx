import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ request: vi.fn(), start: vi.fn(), clearGoogleAttempt: vi.fn(), preview: false }))
vi.mock("@/lib/frontier/google-login", () => ({ GOOGLE_ATTEMPT_LIFETIME_MS: 600000, googleRequest: mocks.request, startGoogleLogin: mocks.start, clearGoogleAttempt: mocks.clearGoogleAttempt }))
vi.mock("@/lib/deployment-environment", () => ({ resolveBackendEnvironment: () => ({ kind: mocks.preview ? "preview" : "development" }) }))
import { GoogleLoginButton } from "./GoogleLoginButton"
afterEach(() => vi.unstubAllGlobals())
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(true) }))
beforeEach(() => { mocks.preview = false; vi.clearAllMocks(); mocks.start.mockRejectedValue(new Error("unavailable")) })
it.each([true, false, "unavailable"])("only explicit activation can start Google; capability=%s", async enabled => {
  if (enabled === "unavailable") mocks.request.mockRejectedValue(new Error("offline"))
  else mocks.request.mockResolvedValue({ enabled })
  render(<GoogleLoginButton signup next="/join/invitation" />)
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("config"))
  expect(mocks.start).not.toHaveBeenCalled()
  if (enabled === true) {
    const button = await screen.findByRole("button", { name: "Continue with Google" })
    expect(screen.getByText("or")).toBeVisible()
    fireEvent.mouseEnter(button); fireEvent.focus(button)
    expect(mocks.start).not.toHaveBeenCalled()
    fireEvent.click(button)
    await screen.findByRole("alert")
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith("/join/invitation", true, undefined, false, expect.any(AbortSignal), false)
    expect(button).toBeEnabled()
  } else {
    await screen.findByRole("alert")
    if (enabled === false) {
      expect(screen.getByText(/isn’t set up for this environment/)).toBeVisible()
      expect(screen.queryByRole("button", {name:"Check Google login again"})).toBeNull()
    } else expect(screen.getByRole("button",{name:"Check Google login again"})).toBeEnabled()
    expect(screen.getByRole("button", {name:"Continue with Google"})).toBeDisabled()
    expect(screen.queryByText("or")).toBeNull()
  }
})

it.each(["button","online"])("recovers capability without provider contact via %s", async trigger => {
  mocks.request.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({enabled:true})
  render(<GoogleLoginButton />)
  const retry = await screen.findByRole("button",{name:"Check Google login again"})
  if (trigger === "button") fireEvent.click(retry)
  else fireEvent(window,new Event("online"))
  await screen.findByRole("button",{name:"Continue with Google"})
  expect(mocks.request).toHaveBeenCalledTimes(2)
  expect(mocks.start).not.toHaveBeenCalled()
})

it("keeps Google visible but disabled in CI without requesting availability or contacting Google", () => {
  mocks.preview = true
  render(<GoogleLoginButton />)
  const button = screen.getByRole("button", { name: "Continue with Google" })
  expect(button).toBeDisabled()
  expect(screen.getByText(/Google login is disabled in CI previews/)).toBeVisible()
  expect(screen.queryByRole("button", { name: "Check Google login again" })).toBeNull()
  fireEvent.click(button)
  fireEvent(window, new Event("online"))
  expect(mocks.request).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it("renders a disabled button immediately while availability is pending", async () => {
  let resolve!: (value: { enabled: boolean }) => void
  mocks.request.mockReturnValue(new Promise(r => { resolve = r }))
  render(<GoogleLoginButton />)
  expect(screen.getByRole("button", { name: "Continue with Google" })).toBeDisabled()
  expect(screen.getByRole("status")).toHaveTextContent("Checking Google login availability")
  expect(mocks.start).not.toHaveBeenCalled()
  resolve({ enabled: true })
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled())
  expect(mocks.start).not.toHaveBeenCalled()
})

it("shows the failure category, never raw server details, and lets the user retry", async () => {
  mocks.request.mockResolvedValue({enabled:true})
  render(<GoogleLoginButton />)
  const button = await screen.findByRole("button", {name:"Continue with Google"})
  await waitFor(() => expect(button).toBeEnabled())
  for (const [error, message] of [["storage_unavailable", /browser couldn’t save/], ["service_unavailable", /Aquilla couldn’t start/], ["rate_limited", /too many login attempts/], ["timeout", /too long/], ["offline", /You’re offline/], ["network_error", /couldn’t reach Aquilla/], ["private server details", /couldn’t open Google login/]] as const) {
    mocks.start.mockRejectedValueOnce(new Error(error))
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message))
    expect(button).toBeEnabled()
    expect(screen.queryByText("private server details")).toBeNull()
  }
})

it("gates desktop on server capability and lets a pending native login be cancelled", async () => {
  vi.stubGlobal("__TAURI__", {})
  mocks.request.mockResolvedValue({enabled:true})
  const view = render(<GoogleLoginButton />)
  await screen.findByText(/isn’t available in the desktop app/)
  expect(screen.getByRole("button", {name:"Continue with Google"})).toBeDisabled()
  expect(mocks.start).not.toHaveBeenCalled()
  view.unmount()
  mocks.request.mockResolvedValue({enabled:true,desktop:true})
  mocks.start.mockResolvedValue(undefined)
  render(<GoogleLoginButton />)
  const button = screen.getByRole("button", {name:"Continue with Google"})
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(screen.getByRole("checkbox", {name: /private Google/}))
  fireEvent.click(button)
  expect(mocks.start.mock.lastCall?.[5]).toBe(true)
  await screen.findByText("Signing in with Google")
  expect(screen.queryByText("or")).toBeNull()
  const signal = mocks.start.mock.lastCall?.[4] as AbortSignal
  fireEvent.click(screen.getByRole("button", {name:"Cancel and use another method"}))
  expect(signal.aborted).toBe(true)
  expect(screen.getByRole("button", {name:"Continue with Google"})).toBeEnabled()
})

it("keeps the Google screen until cancellation in Aquilla after closing the system window", async () => {
  vi.stubGlobal("__TAURI__", {})
  mocks.request.mockResolvedValue({enabled:true, desktop:true})
  mocks.start.mockRejectedValueOnce(new Error("cancelled"))
  render(<GoogleLoginButton />)
  const start = screen.getByRole("button", {name:"Continue with Google"})
  await waitFor(() => expect(start).toBeEnabled())
  fireEvent.click(start)
  await screen.findByText("The Google sign-in window was closed.")
  expect(screen.queryByText("or")).toBeNull()
  fireEvent.click(screen.getByRole("button", {name:"Cancel and use another method"}))
  expect(screen.getByRole("button", {name:"Continue with Google"})).toBeEnabled()
})
