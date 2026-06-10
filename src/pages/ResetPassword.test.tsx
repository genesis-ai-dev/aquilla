/**
 * FRO-270: ResetPassword page tests
 *
 * Covers:
 *  - Form renders token + username from query string params
 *  - Success path calls verifyResetToken + resetPassword + login, then navigates to /
 *  - Invalid/expired token shows recovery copy (TokenExpiredView)
 *  - TokenExpiredView submits to requestPasswordReset
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { ResetPassword } from "./ResetPassword"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockVerifyResetToken = vi.fn()
const mockResetPassword = vi.fn()
const mockRequestPasswordReset = vi.fn()

vi.mock("@/lib/frontier/auth", () => ({
  verifyResetToken: (...args: unknown[]) => mockVerifyResetToken(...args),
  resetPassword: (...args: unknown[]) => mockResetPassword(...args),
  requestPasswordReset: (...args: unknown[]) => mockRequestPasswordReset(...args),
  FrontierAuthError: class FrontierAuthError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))

// checkPasswordRequirements + passwordStrength are pure functions — keep real.
vi.mock("@/components/git-import/FrontierSignupForm", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/components/git-import/FrontierSignupForm")>()
  return mod
})

const mockLogin = vi.fn()
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ login: mockLogin }),
}))

const navigate = vi.fn()
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderReset(search = "?token=tok123&username=alice") {
  return render(
    <MemoryRouter initialEntries={[`/reset-password${search}`]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPassword />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  navigate.mockReset()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResetPassword — token verification", () => {
  it("shows loading state immediately, then valid form after token verified", async () => {
    mockVerifyResetToken.mockResolvedValue(undefined)
    renderReset()

    expect(screen.getByText("Verifying link…")).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByLabelText("New password")).toBeInTheDocument()
    })

    expect(mockVerifyResetToken).toHaveBeenCalledWith("tok123", "alice")
  })

  it("shows recovery view when token is invalid", async () => {
    const { FrontierAuthError } = await import("@/lib/frontier/auth")
    mockVerifyResetToken.mockRejectedValue(new FrontierAuthError("Invalid token", 400))
    renderReset()

    await waitFor(() => {
      expect(screen.getByText(/expired or is invalid/i)).toBeInTheDocument()
    })
    // username should appear in the recovery copy (also in the heading, so use getAllBy)
    expect(screen.getAllByText("alice").length).toBeGreaterThan(0)
    // Recovery form should have a send button
    expect(screen.getByRole("button", { name: /request a new link/i })).toBeInTheDocument()
  })

  it("shows recovery view when token + username are missing from URL", async () => {
    // No search params at all → invalid immediately
    mockVerifyResetToken.mockResolvedValue(undefined) // should not be called
    renderReset("")

    await waitFor(() => {
      expect(screen.getByText(/expired or is invalid/i)).toBeInTheDocument()
    })
    expect(mockVerifyResetToken).not.toHaveBeenCalled()
  })
})

describe("ResetPassword — success path", () => {
  it("calls resetPassword + login on submit and navigates to /", async () => {
    mockVerifyResetToken.mockResolvedValue(undefined)
    mockResetPassword.mockResolvedValue(undefined)
    mockLogin.mockResolvedValue({ username: "alice", jwt: "jwt123" })

    renderReset()

    // Wait for the form to appear
    await waitFor(() => {
      expect(screen.getByLabelText("New password")).toBeInTheDocument()
    })

    const input = screen.getByLabelText("New password")
    fireEvent.change(input, { target: { value: "NewSecret99!" } })

    const submit = screen.getByRole("button", { name: /set new password/i })
    fireEvent.click(submit)

    await waitFor(() => {
      expect(mockResetPassword).toHaveBeenCalledWith("tok123", "alice", "NewSecret99!")
    })
    expect(mockLogin).toHaveBeenCalledWith("alice", "NewSecret99!")
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("shows error message when resetPassword fails", async () => {
    const { FrontierAuthError } = await import("@/lib/frontier/auth")
    mockVerifyResetToken.mockResolvedValue(undefined)
    mockResetPassword.mockRejectedValue(new FrontierAuthError("Token expired", 400))

    renderReset()

    await waitFor(() => {
      expect(screen.getByLabelText("New password")).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "ValidPass1!" },
    })
    fireEvent.click(screen.getByRole("button", { name: /set new password/i }))

    await waitFor(() => {
      expect(screen.getByText("Token expired")).toBeInTheDocument()
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  it("disables submit button when password is too short", async () => {
    mockVerifyResetToken.mockResolvedValue(undefined)
    renderReset()

    await waitFor(() => {
      expect(screen.getByLabelText("New password")).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "short" },
    })

    const submit = screen.getByRole("button", { name: /set new password/i })
    expect(submit).toBeDisabled()
  })
})

describe("ResetPassword — recovery (TokenExpiredView) form", () => {
  it("sends reset request with entered email", async () => {
    const { FrontierAuthError } = await import("@/lib/frontier/auth")
    mockVerifyResetToken.mockRejectedValue(new FrontierAuthError("Invalid token", 400))
    mockRequestPasswordReset.mockResolvedValue(undefined)

    renderReset()

    await waitFor(() => {
      expect(screen.getByLabelText("Email")).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "alice@example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: /request a new link/i }))

    await waitFor(() => {
      expect(mockRequestPasswordReset).toHaveBeenCalledWith("alice@example.com")
    })
    expect(screen.getByText(/new reset link has been sent/i)).toBeInTheDocument()
  })
})
