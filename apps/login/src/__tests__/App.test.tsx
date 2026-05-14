import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AuthClientError } from "@aquilla/auth-client"
import { App } from "../App"

function makeWindowImpl(search = "", origin = "https://aquilla.app"): Window {
  const assign = vi.fn()
  // Minimal Window-shape; only what App uses.
  const w: Partial<Window> = {
    location: {
      search,
      origin,
      assign,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  }
  return w as Window
}

describe("login App", () => {
  it("renders the form with both fields and a submit button", () => {
    const loginFn = vi.fn()
    render(
      <MemoryRouter>
        <App loginFn={loginFn} windowImpl={makeWindowImpl()} />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText(/username or email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument()
  })

  it("submit is disabled until both fields are filled", () => {
    const loginFn = vi.fn()
    render(
      <MemoryRouter>
        <App loginFn={loginFn} windowImpl={makeWindowImpl()} />
      </MemoryRouter>,
    )
    const btn = screen.getByTestId("login-submit") as HTMLButtonElement
    expect(btn).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: "alice" },
    })
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "pw" },
    })
    expect(btn).not.toBeDisabled()
  })

  it("on success calls loginFn and hard-navigates to /projects by default", async () => {
    const loginFn = vi.fn().mockResolvedValue({ jwt: "j", username: "alice" })
    const winImpl = makeWindowImpl()
    render(
      <MemoryRouter>
        <App loginFn={loginFn} windowImpl={winImpl} />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: "alice" },
    })
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "pw1" },
    })
    fireEvent.click(screen.getByTestId("login-submit"))
    await waitFor(() => expect(loginFn).toHaveBeenCalledOnce())
    expect(loginFn).toHaveBeenCalledWith({
      usernameOrEmail: "alice",
      password: "pw1",
    })
    await waitFor(() =>
      expect(winImpl.location.assign).toHaveBeenCalledWith("/projects"),
    )
  })

  it("respects ?return=<path> for same-origin paths", async () => {
    const loginFn = vi.fn().mockResolvedValue({ jwt: "j", username: "alice" })
    const winImpl = makeWindowImpl("?return=%2Fw%2Fabc")
    render(
      <MemoryRouter>
        <App loginFn={loginFn} windowImpl={winImpl} />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: "alice" },
    })
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "pw1" },
    })
    fireEvent.click(screen.getByTestId("login-submit"))
    await waitFor(() =>
      expect(winImpl.location.assign).toHaveBeenCalledWith("/w/abc"),
    )
  })

  it("rejects open-redirect attempts and falls back to default", async () => {
    const loginFn = vi.fn().mockResolvedValue({ jwt: "j", username: "alice" })
    const winImpl = makeWindowImpl("?return=https%3A%2F%2Fevil.com%2Fpwn")
    render(
      <MemoryRouter>
        <App loginFn={loginFn} windowImpl={winImpl} />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: "alice" },
    })
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "pw1" },
    })
    fireEvent.click(screen.getByTestId("login-submit"))
    await waitFor(() =>
      expect(winImpl.location.assign).toHaveBeenCalledWith("/projects"),
    )
  })

  it("surfaces AuthClientError message on failed login", async () => {
    const loginFn = vi
      .fn()
      .mockRejectedValue(
        new AuthClientError(
          401,
          '{"error":"Incorrect username/email or password"}',
          { error: "Incorrect username/email or password" },
        ),
      )
    const winImpl = makeWindowImpl()
    render(
      <MemoryRouter>
        <App loginFn={loginFn} windowImpl={winImpl} />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: "alice" },
    })
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "bad" },
    })
    fireEvent.click(screen.getByTestId("login-submit"))
    const err = await screen.findByTestId("login-error")
    expect(err).toHaveTextContent("Incorrect username/email or password")
    expect(winImpl.location.assign).not.toHaveBeenCalled()
  })

  it("re-enables the submit button after an error so the user can retry", async () => {
    const loginFn = vi
      .fn()
      .mockRejectedValueOnce(
        new AuthClientError(401, "{}", { error: "bad creds" }),
      )
    render(
      <MemoryRouter>
        <App loginFn={loginFn} windowImpl={makeWindowImpl()} />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: "alice" },
    })
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "x" },
    })
    fireEvent.click(screen.getByTestId("login-submit"))
    await screen.findByTestId("login-error")
    expect(screen.getByTestId("login-submit")).not.toBeDisabled()
  })
})
