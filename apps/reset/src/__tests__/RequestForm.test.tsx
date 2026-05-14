import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AuthClientError } from "@aquilla/auth-client"
import { RequestForm } from "../RequestForm"

describe("reset RequestForm", () => {
  it("renders the email field and submit", () => {
    render(
      <MemoryRouter>
        <RequestForm requestFn={vi.fn()} />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /send reset link/i }),
    ).toBeInTheDocument()
  })

  it("disables the submit button until email is entered", () => {
    render(
      <MemoryRouter>
        <RequestForm requestFn={vi.fn()} />
      </MemoryRouter>,
    )
    expect(screen.getByTestId("reset-request-submit")).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "a@b.c" },
    })
    expect(screen.getByTestId("reset-request-submit")).not.toBeDisabled()
  })

  it("on success shows the 'check your email' confirmation", async () => {
    const requestFn = vi.fn().mockResolvedValue(undefined)
    render(
      <MemoryRouter>
        <RequestForm requestFn={requestFn} />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "alice@test.local" },
    })
    fireEvent.click(screen.getByTestId("reset-request-submit"))
    await waitFor(() =>
      expect(requestFn).toHaveBeenCalledWith("alice@test.local"),
    )
    expect(await screen.findByTestId("reset-sent")).toBeInTheDocument()
  })

  it("on error surfaces the AuthClientError message", async () => {
    const requestFn = vi
      .fn()
      .mockRejectedValue(
        new AuthClientError(500, '{"error":"server down"}', {
          error: "server down",
        }),
      )
    render(
      <MemoryRouter>
        <RequestForm requestFn={requestFn} />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "alice@test.local" },
    })
    fireEvent.click(screen.getByTestId("reset-request-submit"))
    const err = await screen.findByTestId("reset-error")
    expect(err).toHaveTextContent(/server down/i)
  })
})
