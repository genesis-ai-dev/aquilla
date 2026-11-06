import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ request: vi.fn(), start: vi.fn() }))
vi.mock("@/lib/frontier/google-login", () => ({ googleRequest: mocks.request, startGoogleLogin: mocks.start }))
import { GoogleLoginButton } from "./GoogleLoginButton"
beforeEach(() => { vi.clearAllMocks(); mocks.start.mockRejectedValue(new Error("unavailable")) })
it.each([true, false, "unavailable"])("only explicit activation can start Google; capability=%s", async enabled => {
  if (enabled === "unavailable") mocks.request.mockRejectedValue(new Error("offline"))
  else mocks.request.mockResolvedValue({ enabled })
  render(<GoogleLoginButton signup next="/join/invitation" />)
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("config"))
  expect(mocks.start).not.toHaveBeenCalled()
  if (enabled === true) {
    const button = await screen.findByRole("button", { name: "Continue with Google" })
    fireEvent.mouseEnter(button); fireEvent.focus(button)
    expect(mocks.start).not.toHaveBeenCalled()
    fireEvent.click(button)
    await screen.findByRole("alert")
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith("/join/invitation", true)
    expect(button).toBeEnabled()
  } else expect(screen.queryByRole("button")).toBeNull()
})
