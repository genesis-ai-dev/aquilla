import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AuthClientError } from "@aquilla/auth-client"
import { App } from "../App"

function makeWindowImpl(search = "", origin = "https://aquilla.app"): Window {
  const assign = vi.fn()
  const w: Partial<Window> = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    location: { search, origin, assign } as any,
  }
  return w as Window
}

function fill(form: {
  username?: string
  email?: string
  password?: string
  confirm?: string
}) {
  if (form.username !== undefined) {
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: form.username },
    })
  }
  if (form.email !== undefined) {
    fireEvent.change(screen.getByLabelText(/^email$/i), {
      target: { value: form.email },
    })
  }
  if (form.password !== undefined) {
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: form.password },
    })
  }
  if (form.confirm !== undefined) {
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: form.confirm },
    })
  }
}

describe("signup App", () => {
  it("renders all required fields and a submit button", () => {
    render(
      <MemoryRouter>
        <App signupFn={vi.fn()} windowImpl={makeWindowImpl()} />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /create account/i }),
    ).toBeInTheDocument()
  })

  it("does not call signupFn when validation fails (mismatched passwords)", async () => {
    const signupFn = vi.fn()
    render(
      <MemoryRouter>
        <App signupFn={signupFn} windowImpl={makeWindowImpl()} />
      </MemoryRouter>,
    )
    fill({
      username: "alice",
      email: "alice@test.local",
      password: "longenoughpw",
      confirm: "different",
    })
    fireEvent.click(screen.getByTestId("signup-submit"))
    expect(signupFn).not.toHaveBeenCalled()
    expect(await screen.findByText(/passwords don't match/i)).toBeInTheDocument()
  })

  it("does not call signupFn when password is too short", async () => {
    const signupFn = vi.fn()
    render(
      <MemoryRouter>
        <App signupFn={signupFn} windowImpl={makeWindowImpl()} />
      </MemoryRouter>,
    )
    fill({
      username: "alice",
      email: "alice@test.local",
      password: "short",
      confirm: "short",
    })
    fireEvent.click(screen.getByTestId("signup-submit"))
    expect(signupFn).not.toHaveBeenCalled()
    expect(await screen.findByText(/at least 8/i)).toBeInTheDocument()
  })

  it("does not call signupFn for a bad-looking email", async () => {
    const signupFn = vi.fn()
    render(
      <MemoryRouter>
        <App signupFn={signupFn} windowImpl={makeWindowImpl()} />
      </MemoryRouter>,
    )
    fill({
      username: "alice",
      email: "no-at-sign",
      password: "longenoughpw",
      confirm: "longenoughpw",
    })
    fireEvent.click(screen.getByTestId("signup-submit"))
    expect(signupFn).not.toHaveBeenCalled()
    expect(await screen.findByText(/doesn't look like an email/i))
      .toBeInTheDocument()
  })

  it("on success calls signupFn and hard-navigates to /projects by default", async () => {
    const signupFn = vi.fn().mockResolvedValue({ jwt: "j", username: "alice" })
    const winImpl = makeWindowImpl()
    render(
      <MemoryRouter>
        <App signupFn={signupFn} windowImpl={winImpl} />
      </MemoryRouter>,
    )
    fill({
      username: "alice",
      email: "alice@test.local",
      password: "longenoughpw",
      confirm: "longenoughpw",
    })
    fireEvent.click(screen.getByTestId("signup-submit"))
    await waitFor(() => expect(signupFn).toHaveBeenCalledOnce())
    expect(signupFn).toHaveBeenCalledWith({
      username: "alice",
      email: "alice@test.local",
      password: "longenoughpw",
    })
    await waitFor(() =>
      expect(winImpl.location.assign).toHaveBeenCalledWith("/projects"),
    )
  })

  it("respects ?return= for same-origin path", async () => {
    const signupFn = vi.fn().mockResolvedValue({ jwt: "j", username: "alice" })
    const winImpl = makeWindowImpl("?return=%2Fw%2Fxyz")
    render(
      <MemoryRouter>
        <App signupFn={signupFn} windowImpl={winImpl} />
      </MemoryRouter>,
    )
    fill({
      username: "alice",
      email: "alice@test.local",
      password: "longenoughpw",
      confirm: "longenoughpw",
    })
    fireEvent.click(screen.getByTestId("signup-submit"))
    await waitFor(() =>
      expect(winImpl.location.assign).toHaveBeenCalledWith("/w/xyz"),
    )
  })

  it("surfaces 409 user-already-exists from the server", async () => {
    const signupFn = vi.fn().mockRejectedValue(
      new AuthClientError(409, '{"error":"User already exists"}', {
        error: "User already exists",
      }),
    )
    render(
      <MemoryRouter>
        <App signupFn={signupFn} windowImpl={makeWindowImpl()} />
      </MemoryRouter>,
    )
    fill({
      username: "alice",
      email: "alice@test.local",
      password: "longenoughpw",
      confirm: "longenoughpw",
    })
    fireEvent.click(screen.getByTestId("signup-submit"))
    const err = await screen.findByTestId("signup-error")
    expect(err).toHaveTextContent(/user already exists/i)
  })
})
