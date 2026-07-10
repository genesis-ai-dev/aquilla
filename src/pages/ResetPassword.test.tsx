import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { ResetPassword } from "./ResetPassword"

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
    expect(screen.getAllByText("alice").length).toBeGreaterThan(0)
    expect(screen.getByRole("button", { name: /request a new link/i })).toBeInTheDocument()
  })

  it("shows recovery view when token + username are missing from URL", async () => {
    mockVerifyResetToken.mockResolvedValue(undefined)
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

    await waitFor(() => {
      expect(screen.getByLabelText("New password")).toBeInTheDocument()
    })

    fireEvent.change(document.getElementById("rp-new-password")!, {
      target: { value: "NewSecret99!" },
    })
    fireEvent.submit(document.getElementById("reset-password-form")!)

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

    fireEvent.change(document.getElementById("rp-new-password")!, {
      target: { value: "ValidPass1!" },
    })
    fireEvent.submit(document.getElementById("reset-password-form")!)

    await waitFor(() => {
      expect(screen.getByText("Token expired")).toBeInTheDocument()
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  it("shows validation error when password is too short", async () => {
    mockVerifyResetToken.mockResolvedValue(undefined)
    renderReset()

    await waitFor(() => {
      expect(screen.getByLabelText("New password")).toBeInTheDocument()
    })

    fireEvent.change(document.getElementById("rp-new-password")!, {
      target: { value: "short" },
    })
    fireEvent.submit(document.getElementById("reset-password-form")!)

    await waitFor(() => {
      expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument()
    })
    expect(mockResetPassword).not.toHaveBeenCalled()
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
    fireEvent.submit(document.getElementById("token-expired-form")!)

    await waitFor(() => {
      expect(mockRequestPasswordReset).toHaveBeenCalledWith("alice@example.com")
    })
    expect(screen.getByText(/new reset link has been sent/i)).toBeInTheDocument()
  })
})
