import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { AuthClientError } from "@aquilla/auth-client"
import { SubmitForm } from "../SubmitForm"

function makeWindowImpl(): Window {
  const assign = vi.fn()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { location: { assign } as any } as Window
}

// Renders SubmitForm under a MemoryRouter at /:token?username=<u>. Mirrors
// the production routing shape so useParams + useSearchParams resolve.
function renderAt(
  pathWithQuery: string,
  props: Parameters<typeof SubmitForm>[0],
) {
  return render(
    <MemoryRouter initialEntries={[pathWithQuery]}>
      <Routes>
        <Route path="/:token" element={<SubmitForm {...props} />} />
        <Route path="/" element={<SubmitForm {...props} />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("reset SubmitForm", () => {
  it("shows 'incomplete link' page when token or username missing", () => {
    renderAt("/sometoken", {
      submitFn: vi.fn(),
      verifyFn: vi.fn().mockResolvedValue(true),
      // no username in querystring → incomplete
    })
    expect(screen.getByText(/reset link is incomplete/i)).toBeInTheDocument()
  })

  it("renders the new-password form when token+username present and verify passes", async () => {
    const verifyFn = vi.fn().mockResolvedValue(true)
    renderAt("/tok?username=alice", {
      submitFn: vi.fn(),
      verifyFn,
    })
    await waitFor(() => expect(verifyFn).toHaveBeenCalled())
    expect(verifyFn).toHaveBeenCalledWith({ token: "tok", username: "alice" })
    expect(await screen.findByTestId("reset-submit-form")).toBeInTheDocument()
    expect(screen.getByText(/alice/i)).toBeInTheDocument()
  })

  it("shows invalid-link page when verify returns false", async () => {
    const verifyFn = vi.fn().mockResolvedValue(false)
    renderAt("/tok?username=alice", {
      submitFn: vi.fn(),
      verifyFn,
    })
    expect(
      await screen.findByText(/this reset link is invalid or expired/i),
    ).toBeInTheDocument()
  })

  it("rejects mismatched passwords locally without calling submitFn", async () => {
    const submitFn = vi.fn()
    const verifyFn = vi.fn().mockResolvedValue(true)
    renderAt("/tok?username=alice", { submitFn, verifyFn })
    await screen.findByTestId("reset-submit-form")

    fireEvent.change(screen.getByLabelText(/^new password$/i), {
      target: { value: "longenoughpw" },
    })
    fireEvent.change(screen.getByLabelText(/confirm new password/i), {
      target: { value: "different" },
    })
    fireEvent.click(screen.getByTestId("reset-submit"))
    expect(submitFn).not.toHaveBeenCalled()
    expect(await screen.findByText(/passwords don't match/i)).toBeInTheDocument()
  })

  it("rejects short passwords locally", async () => {
    const submitFn = vi.fn()
    const verifyFn = vi.fn().mockResolvedValue(true)
    renderAt("/tok?username=alice", { submitFn, verifyFn })
    await screen.findByTestId("reset-submit-form")

    fireEvent.change(screen.getByLabelText(/^new password$/i), {
      target: { value: "short" },
    })
    fireEvent.change(screen.getByLabelText(/confirm new password/i), {
      target: { value: "short" },
    })
    fireEvent.click(screen.getByTestId("reset-submit"))
    expect(submitFn).not.toHaveBeenCalled()
    expect(
      await screen.findByText(/must be at least 8 characters/i),
    ).toBeInTheDocument()
  })

  it("on success calls submitFn and hard-navigates to /login/?reset=1", async () => {
    const submitFn = vi.fn().mockResolvedValue(undefined)
    const verifyFn = vi.fn().mockResolvedValue(true)
    const winImpl = makeWindowImpl()
    renderAt("/tok?username=alice", {
      submitFn,
      verifyFn,
      windowImpl: winImpl,
    })
    await screen.findByTestId("reset-submit-form")

    fireEvent.change(screen.getByLabelText(/^new password$/i), {
      target: { value: "freshlongpw" },
    })
    fireEvent.change(screen.getByLabelText(/confirm new password/i), {
      target: { value: "freshlongpw" },
    })
    fireEvent.click(screen.getByTestId("reset-submit"))

    await waitFor(() =>
      expect(submitFn).toHaveBeenCalledWith({
        token: "tok",
        username: "alice",
        newPassword: "freshlongpw",
      }),
    )
    await waitFor(() =>
      expect(winImpl.location.assign).toHaveBeenCalledWith(
        "/login/?reset=1",
      ),
    )
  })

  it("surfaces AuthClientError from submit", async () => {
    const submitFn = vi
      .fn()
      .mockRejectedValue(
        new AuthClientError(400, '{"error":"Token expired"}', {
          error: "Token expired",
        }),
      )
    const verifyFn = vi.fn().mockResolvedValue(true)
    const winImpl = makeWindowImpl()
    renderAt("/tok?username=alice", {
      submitFn,
      verifyFn,
      windowImpl: winImpl,
    })
    await screen.findByTestId("reset-submit-form")

    fireEvent.change(screen.getByLabelText(/^new password$/i), {
      target: { value: "freshlongpw" },
    })
    fireEvent.change(screen.getByLabelText(/confirm new password/i), {
      target: { value: "freshlongpw" },
    })
    fireEvent.click(screen.getByTestId("reset-submit"))

    const err = await screen.findByTestId("reset-error")
    expect(err).toHaveTextContent(/token expired/i)
    expect(winImpl.location.assign).not.toHaveBeenCalled()
  })

  it("accepts token from query when path has no :token", async () => {
    const verifyFn = vi.fn().mockResolvedValue(true)
    render(
      <MemoryRouter initialEntries={["/?token=querytoken&username=alice"]}>
        <Routes>
          <Route
            path="/"
            element={<SubmitForm submitFn={vi.fn()} verifyFn={verifyFn} />}
          />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(verifyFn).toHaveBeenCalledWith({
        token: "querytoken",
        username: "alice",
      }),
    )
  })
})
