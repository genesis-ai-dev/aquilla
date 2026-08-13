/**
 * AdminElevationGate — the step-up "sudo" prompt. Verifies the two-phase flow:
 * request a code, then enter the 6-digit code to elevate. The worker is the
 * real gate; here we assert the UI drives the request/verify endpoints and
 * calls onElevated on success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import { AdminElevationGate } from "./AdminElevationGate"

vi.mock("@/lib/frontier/admin", () => ({
  requestAdminElevation: vi.fn(),
  verifyAdminElevation: vi.fn(),
}))
import { requestAdminElevation, verifyAdminElevation } from "@/lib/frontier/admin"
const mockRequest = vi.mocked(requestAdminElevation)
const mockVerify = vi.mocked(verifyAdminElevation)

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("AdminElevationGate", () => {
  it("requests a code, then verifies it and calls onElevated", async () => {
    mockRequest.mockResolvedValue({ sent: false, devCode: "123456" })
    mockVerify.mockResolvedValue({ elevatedUntil: "2026-07-01T00:00:00Z" })
    const onElevated = vi.fn()

    render(<AdminElevationGate jwt="jwt" email="danieljlosey@gmail.com" onElevated={onElevated} />)

    fireEvent.click(screen.getByRole("button", { name: /email me a code/i }))

    const input = await screen.findByLabelText(/verification code/i)
    expect(mockRequest).toHaveBeenCalledWith("jwt")

    // Single OTP input — paste/type the full code; onComplete submits.
    fireEvent.input(input, { target: { value: "123456" } })

    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith("jwt", "123456"))
    await waitFor(() => expect(onElevated).toHaveBeenCalled())
  })

  it("shows the server error on a bad code without elevating", async () => {
    mockRequest.mockResolvedValue({ sent: false, devCode: "111111" })
    mockVerify.mockRejectedValue(new Error("That code is invalid or has expired."))
    const onElevated = vi.fn()

    render(<AdminElevationGate jwt="jwt" email={null} onElevated={onElevated} />)
    fireEvent.click(screen.getByRole("button", { name: /email me a code/i }))
    const input = await screen.findByLabelText(/verification code/i)
    fireEvent.input(input, { target: { value: "999999" } })

    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument()
    expect(onElevated).not.toHaveBeenCalled()
  })
})
