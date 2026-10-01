/**
 * AdminElevationPrompt: hidden until the elevation-required signal fires, then
 * hosts the step-up gate; after a verify it confirms and closing clears the signal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react"
import { AdminElevationPrompt } from "./AdminElevationPrompt"
import {
  clearElevationRequired,
  isElevationRequired,
  notifyElevationRequired,
} from "@/lib/errors/elevation-required-signal"

vi.mock("@/lib/frontier/admin", () => ({
  requestAdminElevation: vi.fn(),
  verifyAdminElevation: vi.fn(),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt" } }),
}))
import { requestAdminElevation, verifyAdminElevation } from "@/lib/frontier/admin"
const mockRequest = vi.mocked(requestAdminElevation)
const mockVerify = vi.mocked(verifyAdminElevation)

beforeEach(() => {
  vi.clearAllMocks()
  clearElevationRequired()
})
afterEach(async () => {
  cleanup()
  // input-otp leaves short timers pending after unmount (see AdminElevationGate.test).
  await new Promise((resolve) => setTimeout(resolve, 60))
  clearElevationRequired()
})

describe("AdminElevationPrompt", () => {
  it("renders nothing and calls no endpoint by default", () => {
    render(<AdminElevationPrompt />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it("opens on the signal with the step-up wording", async () => {
    render(<AdminElevationPrompt />)
    act(() => notifyElevationRequired())
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText(/this needs your admin code/i)).toBeInTheDocument()
  })

  it("confirms after verify and clears the signal on close", async () => {
    mockRequest.mockResolvedValue({ sent: false, devCode: "123456" })
    mockVerify.mockResolvedValue({ elevatedUntil: "2026-07-01T00:00:00Z" })
    render(<AdminElevationPrompt />)
    act(() => notifyElevationRequired())

    fireEvent.click(await screen.findByRole("button", { name: /email me a code/i }))
    const input = await screen.findByLabelText(/verification code/i)
    fireEvent.input(input, { target: { value: "123456" } })

    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith("jwt", "123456"))
    expect(await screen.findByText("Verified. Try again.")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(isElevationRequired()).toBe(false))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })
})
