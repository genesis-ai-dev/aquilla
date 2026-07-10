/**
 * FRO-282: Login page tests
 *
 * Covers:
 *  - Page renders username + password fields and a Sign in button
 *  - Successful login navigates to /
 *  - Auth error shown in the form
 *  - "Forgot password?" link switches to forgot-password mode
 *  - "Create an account" link points to /onboarding
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { Login } from "./Login"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockLogin = vi.fn()
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ login: mockLogin }),
}))

// Mock FrontierForgotPasswordForm to avoid pulling in its own deps in unit tests.
vi.mock("@/components/git-import/FrontierForgotPasswordForm", () => ({
  FrontierForgotPasswordForm: ({ onBack }: { onBack: () => void }) => (
    <div>
      <p>Forgot password form</p>
      <button onClick={onBack}>Back to login</button>
    </div>
  ),
}))

vi.mock("@/lib/frontier/auth", () => ({
  FrontierAuthError: class FrontierAuthError extends Error {
    status: number
    constructor(message: string, status = 400) {
      super(message)
      this.status = status
    }
  },
}))

const navigate = vi.fn()
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fillLogin(username: string, password: string) {
  fireEvent.change(screen.getByLabelText(/username or email/i), {
    target: { value: username },
  })
  fireEvent.change(document.getElementById("login-pass")!, {
    target: { value: password },
  })
}

function submitLogin() {
  return act(async () => {
    fireEvent.submit(document.getElementById("login-form")!)
  })
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
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

describe("Login page — rendering", () => {
  it("renders username/email and password fields", () => {
    renderLogin()
    expect(screen.getByLabelText(/username or email/i)).toBeInTheDocument()
    // Use exact label text to avoid matching the 'Show password' aria-label button.
    expect(screen.getByLabelText("Password")).toBeInTheDocument()
  })

  it("renders a Sign in button that stays enabled and validates on submit", async () => {
    renderLogin()
    const btn = screen.getByRole("button", { name: /^sign in$/i })
    expect(btn).toBeEnabled()
    await submitLogin()
    await waitFor(() => {
      expect(screen.getByText(/username or email is required/i)).toBeInTheDocument()
    })
  })

  it("renders a 'Create an account' link pointing to /onboarding", () => {
    renderLogin()
    const link = screen.getByRole("link", { name: /create an account/i })
    expect(link).toHaveAttribute("href", "/onboarding")
  })
})

describe("Login page — success path", () => {
  it("calls login and navigates to / on success", async () => {
    mockLogin.mockResolvedValue({ username: "alice", jwt: "tok" })
    renderLogin()

    fillLogin("alice", "secret")
    await submitLogin()

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith("alice", "secret")
    })
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
  })
})

describe("Login page — error handling", () => {
  it("shows auth error message when login fails", async () => {
    const { FrontierAuthError } = await import("@/lib/frontier/auth")
    mockLogin.mockRejectedValue(new FrontierAuthError("Invalid credentials", 401))
    renderLogin()

    fillLogin("alice", "wrong")
    await submitLogin()

    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument()
    })
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe("Login page — show/hide password", () => {
  it("toggles password visibility via the eye button", () => {
    renderLogin()
    const passInput = screen.getByLabelText("Password")
    expect(passInput).toHaveAttribute("type", "password")

    fireEvent.click(screen.getByRole("button", { name: /show password/i }))
    expect(passInput).toHaveAttribute("type", "text")

    fireEvent.click(screen.getByRole("button", { name: /hide password/i }))
    expect(passInput).toHaveAttribute("type", "password")
  })
})

describe("Login page — forgot password flow", () => {
  it("switches to forgot-password mode when link is clicked", () => {
    renderLogin()
    fireEvent.click(screen.getByRole("button", { name: /forgot password/i }))
    expect(screen.getByText("Forgot password form")).toBeInTheDocument()
  })

  it("returns to login mode from forgot-password form", () => {
    renderLogin()
    fireEvent.click(screen.getByRole("button", { name: /forgot password/i }))
    expect(screen.getByText("Forgot password form")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /back to login/i }))
    expect(screen.getByLabelText(/username or email/i)).toBeInTheDocument()
  })
})

// FRO-293: ?next= param — post-login navigation returns to the originating route
describe("Login page — next param", () => {
  it("navigates to ?next= path after successful login", async () => {
    mockLogin.mockResolvedValue({ username: "alice", jwt: "tok" })

    render(
      <MemoryRouter initialEntries={["/login?next=%2Fprojects"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
        </Routes>
      </MemoryRouter>,
    )

    fillLogin("alice", "secret")
    await submitLogin()

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith("alice", "secret"))
    // Should navigate to /projects (the decoded ?next= value)
    expect(navigate).toHaveBeenCalledWith("/projects", { replace: true })
  })

  it("falls back to / when no ?next= is present", async () => {
    mockLogin.mockResolvedValue({ username: "alice", jwt: "tok" })
    renderLogin() // uses /login with no search params

    fillLogin("alice", "secret")
    await submitLogin()

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith("alice", "secret"))
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("ignores external ?next= values to prevent open-redirect", async () => {
    mockLogin.mockResolvedValue({ username: "alice", jwt: "tok" })

    render(
      <MemoryRouter initialEntries={["/login?next=https%3A%2F%2Fevil.example.com"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
        </Routes>
      </MemoryRouter>,
    )

    fillLogin("alice", "secret")
    await submitLogin()

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith("alice", "secret"))
    // Must NOT navigate to the external URL — falls back to /
    expect(navigate).toHaveBeenCalledWith("/", { replace: true })
  })
})
