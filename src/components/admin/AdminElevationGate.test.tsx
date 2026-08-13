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
afterEach(async () => {
  cleanup()
  // OPS-11 (docs/OPSEC-REVIEW-2026-08-13.md). `input-otp` schedules three
  // setTimeouts — 0ms, 10ms, 50ms — on every value/focus change and never
  // clears them (its `syncTimeouts` helper returns the ids and its effect
  // returns no cleanup). Unmounting does not cancel them.
  //
  // If the run ends inside that 50ms window, the stray callbacks fire after
  // Vitest has torn the happy-dom environment down: React's dispatchSetState
  // reaches for `window`, it is gone, and the ReferenceError surfaces as an
  // UNHANDLED error. Vitest 4 fails a run on an unhandled error even when
  // every test passed — so `pnpm test` exited 1 with "7328 passed", the root
  // lane failed, and the Workers Builds gate went red for every pull request
  // in the repository from 2026-08-11 (the commit that added this file) until
  // now, regardless of what the pull request changed.
  //
  // Waiting the window out here lets the callbacks land while the DOM still
  // exists, where React discards an update to an unmounted tree in silence.
  // The real fix belongs upstream in input-otp; this keeps the leak inside the
  // one test file that can trigger it, at a cost of ~60ms per test.
  await new Promise((resolve) => setTimeout(resolve, 60))
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
