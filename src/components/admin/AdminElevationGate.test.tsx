/**
 * AdminElevationGate — the step-up "sudo" prompt. Verifies the two-phase flow:
 * request a code, then enter the 6-digit code to elevate. The worker is the
 * real gate; here we assert the UI drives the request/verify endpoints and
 * calls onElevated on success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react"
import { AdminElevationGate } from "./AdminElevationGate"

vi.mock("@/lib/frontier/admin", () => ({
  adminTotp: vi.fn().mockResolvedValue({ enabled: false }),
  requestAdminElevation: vi.fn(),
  verifyAdminElevation: vi.fn(),
}))
import {
  requestAdminElevation,
  verifyAdminElevation,
} from "@/lib/frontier/admin"
const mockRequest = vi.mocked(requestAdminElevation)
const mockVerify = vi.mocked(verifyAdminElevation)

beforeEach(() => vi.clearAllMocks())
afterEach(async () => {
  cleanup()
  // AQU-919: input-otp leaves 0/10/50 ms callbacks pending after unmount.
  // Let them settle before happy-dom removes `window`, otherwise the root
  // suite can finish all assertions and still exit non-zero on the leak.
  await new Promise((resolve) => setTimeout(resolve, 60))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("AdminElevationGate", () => {
  it("requests a code, then verifies it and calls onElevated", async () => {
    mockRequest.mockResolvedValue({ sent: false, devCode: "123456" })
    mockVerify.mockResolvedValue({ elevatedUntil: "2026-07-01T00:00:00Z" })
    const onElevated = vi.fn()

    render(
      <AdminElevationGate
        jwt="jwt"
        email="admin@example.com"
        onElevated={onElevated}
      />,
    )

    fireEvent.click(
      await screen.findByRole("button", { name: /email me a code/i }),
    )

    const input = await screen.findByLabelText(/verification code/i)
    expect(mockRequest).toHaveBeenCalledWith("jwt")

    // Single OTP input — paste/type the full code; onComplete submits.
    fireEvent.input(input, { target: { value: "123456" } })

    await waitFor(() =>
      expect(mockVerify).toHaveBeenCalledWith("jwt", "123456"),
    )
    await waitFor(() => expect(onElevated).toHaveBeenCalled())
  })

  it("shows the server error on a bad code without elevating", async () => {
    mockRequest.mockResolvedValue({ sent: false, devCode: "111111" })
    mockVerify.mockRejectedValue(
      new Error("That code is invalid or has expired."),
    )
    const onElevated = vi.fn()

    render(
      <AdminElevationGate jwt="jwt" email={null} onElevated={onElevated} />,
    )
    fireEvent.click(
      await screen.findByRole("button", { name: /email me a code/i }),
    )
    const input = await screen.findByLabelText(/verification code/i)
    fireEvent.input(input, { target: { value: "999999" } })

    expect(
      await screen.findByText(/invalid or has expired/i),
    ).toBeInTheDocument()
    expect(onElevated).not.toHaveBeenCalled()
  })
})

it("offers TOTP and recovery instead of email for enrolled admins", async () => {
  const { adminTotp } = await import("@/lib/frontier/admin")
  vi.mocked(adminTotp).mockResolvedValue({ enabled: true })
  const done = vi.fn()
  render(
    <AdminElevationGate
      jwt="enrolled"
      email="admin@example.com"
      onElevated={done}
    />,
  )
  await screen.findByLabelText("Verification code")
  expect(screen.queryByRole("button", { name: /email me a code/i })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Use a recovery code" }))
  fireEvent.change(screen.getByLabelText("Recovery code"), {
    target: { value: "RECOVERY" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Verify recovery code" }))
  await waitFor(() =>
    expect(adminTotp).toHaveBeenCalledWith("enrolled", "verify", {
      code: "RECOVERY",
      recovery: true,
    }),
  )
  expect(mockRequest).not.toHaveBeenCalled()
  await waitFor(() => expect(done).toHaveBeenCalled())
})

it("copies the current development code, reports clipboard failure, and refreshes it on resend", async () => {
  const { adminTotp } = await import("@/lib/frontier/admin")
  vi.mocked(adminTotp).mockResolvedValue({ enabled: false })
  mockRequest
    .mockResolvedValueOnce({ sent: false, devCode: "123456" })
    .mockResolvedValueOnce({ sent: false, devCode: "654321" })
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(undefined)
  vi.stubGlobal("navigator", { clipboard: { writeText } })
  render(
    <AdminElevationGate
      jwt="copy-test"
      email={null}
      onElevated={vi.fn()}
      compact
    />,
  )
  fireEvent.click(
    await screen.findByRole("button", { name: "Email me a code" }),
  )
  fireEvent.click(await screen.findByRole("button", { name: "Copy code" }))
  await screen.findByText(/Could not copy/)
  expect(writeText).toHaveBeenLastCalledWith("123456")
  fireEvent.click(screen.getByRole("button", { name: "Resend code" }))
  await screen.findByText(/654321/)
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }))
  await screen.findByText("Copied")
  expect(writeText).toHaveBeenLastCalledWith("654321")
  expect(mockVerify).not.toHaveBeenCalled()
})
