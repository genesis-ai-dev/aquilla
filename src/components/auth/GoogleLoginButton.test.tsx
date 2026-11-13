import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ request: vi.fn(), start: vi.fn(), preview: false }))
vi.mock("@/lib/frontier/google-login", () => ({ googleRequest: mocks.request, startGoogleLogin: mocks.start }))
vi.mock("@/lib/deployment-environment", () => ({ resolveBackendEnvironment: () => ({ kind: mocks.preview ? "preview" : "development" }) }))
import { GoogleLoginButton } from "./GoogleLoginButton"
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
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith("/join/invitation", true)
    expect(button).toBeEnabled()
  } else {
    await screen.findByRole("alert")
    if (enabled === false) {
      expect(screen.getByText(/isn’t set up for this environment/)).toBeVisible()
      expect(screen.queryByRole("button", {name:"Retry Google login availability"})).toBeNull()
    } else expect(screen.getByRole("button",{name:"Retry Google login availability"})).toBeEnabled()
    expect(screen.getByRole("button", {name:"Continue with Google"})).toBeDisabled()
    expect(screen.queryByText("or")).toBeNull()
  }
})

it.each(["button","online"])("recovers capability without provider contact via %s", async trigger => {
  mocks.request.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({enabled:true})
  render(<GoogleLoginButton />)
  const retry = await screen.findByRole("button",{name:"Retry Google login availability"})
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
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull()
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
