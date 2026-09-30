import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { FrontierSignupForm } from "./FrontierSignupForm"
import { FrontierAuthError } from "@/lib/frontier/auth"

const register = vi.fn()

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ register }),
}))

/**
 * AQU-1345 — a refused sign-up used to dead-end on a bare "User already
 * exists". The way forward is to sign in: a Codex identity is migrated on
 * first login. The refusal must say so, and must say the SAME thing whether
 * the name is already in Aquilla or only reserved in Codex, or the form
 * becomes an account-enumeration oracle.
 */
const TAKEN_COPY =
  "An account with this username or email already exists. If you already use Codex, " +
  "sign in with those credentials — your account and projects come across automatically."

async function submitValidSignup(username = "randall") {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: username } })
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: `${username}@example.com` } })
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse 42" } })
  fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form")!)
}

describe("FrontierSignupForm identity-taken redirection (AQU-1345)", () => {
  beforeEach(() => {
    register.mockReset()
  })

  it("shows the sign-in redirection copy when registration is refused with 409", async () => {
    register.mockRejectedValue(
      new FrontierAuthError("Couldn't create your account: User already exists", 409),
    )
    render(<FrontierSignupForm onSuccess={() => {}} onSwitchToLogin={() => {}} />)
    await submitValidSignup()

    const alert = await screen.findByTestId("signup-identity-taken")
    expect(alert).toHaveTextContent(TAKEN_COPY)
    // The bare server sentence is what dead-ended people; it must not be the
    // thing on screen any more.
    expect(alert).not.toHaveTextContent("Couldn't create your account")
  })

  it("renders word-for-word identical copy whichever datastore owns the identity", async () => {
    // The worker collapses the Neon-duplicate and the legacy-Codex-reservation
    // branches onto one 409 body; the component keys off the STATUS, so the two
    // cannot diverge here either. Two different bodies, one rendering.
    register.mockRejectedValueOnce(new FrontierAuthError("User already exists", 409))
    const { unmount } = render(<FrontierSignupForm onSuccess={() => {}} onSwitchToLogin={() => {}} />)
    await submitValidSignup()
    const aquillaCopy = (await screen.findByTestId("signup-identity-taken")).textContent
    unmount()

    register.mockRejectedValueOnce(
      new FrontierAuthError("Couldn't create your account: User already exists", 409),
    )
    render(<FrontierSignupForm onSuccess={() => {}} onSwitchToLogin={() => {}} />)
    await submitValidSignup()
    const codexCopy = (await screen.findByTestId("signup-identity-taken")).textContent

    expect(codexCopy).toBe(aquillaCopy)
  })

  it("hands the typed identifier to the sign-in switch", async () => {
    register.mockRejectedValue(new FrontierAuthError("User already exists", 409))
    const onSwitchToLogin = vi.fn()
    render(<FrontierSignupForm onSuccess={() => {}} onSwitchToLogin={onSwitchToLogin} />)
    await submitValidSignup("randall")

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }))
    expect(onSwitchToLogin).toHaveBeenCalledWith("randall")
  })

  it("still shows the copy on a surface with no sign-in form to switch to", async () => {
    register.mockRejectedValue(new FrontierAuthError("User already exists", 409))
    render(<FrontierSignupForm onSuccess={() => {}} />)

    await submitValidSignup()
    expect(await screen.findByTestId("signup-identity-taken")).toHaveTextContent(TAKEN_COPY)
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull()
  })

  it("leaves non-409 failures on the ordinary error path", async () => {
    register.mockRejectedValue(
      new FrontierAuthError("Couldn't create your account. Please try again.", 500),
    )
    render(<FrontierSignupForm onSuccess={() => {}} onSwitchToLogin={() => {}} />)
    await submitValidSignup()

    expect(
      await screen.findByText("Couldn't create your account. Please try again."),
    ).toBeInTheDocument()
    expect(screen.queryByTestId("signup-identity-taken")).toBeNull()
  })

  it("clears a previous refusal when the form is resubmitted", async () => {
    register.mockRejectedValueOnce(new FrontierAuthError("User already exists", 409))
    render(<FrontierSignupForm onSuccess={() => {}} onSwitchToLogin={() => {}} />)
    await submitValidSignup("taken")
    expect(await screen.findByTestId("signup-identity-taken")).toBeInTheDocument()

    register.mockResolvedValueOnce({ username: "fresh" })
    await submitValidSignup("fresh")
    await waitFor(() => expect(screen.queryByTestId("signup-identity-taken")).toBeNull())
  })
})
