// AQU-626: per-user deep link + PIN landing page.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { AccessLinkPage } from "./AccessLinkPage"
import { redeemAccessLink, FrontierAuthError } from "@/lib/frontier/auth"

const navigate = vi.fn()
vi.mock("react-router-dom", async (i) => ({
  ...(await i<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))

vi.mock("@/lib/frontier/auth", async (i) => ({
  ...(await i<typeof import("@/lib/frontier/auth")>()),
  redeemAccessLink: vi.fn(),
}))

const redeemMock = vi.mocked(redeemAccessLink)

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/link/tok123"]}>
      <Routes>
        <Route path="/link/:token" element={<AccessLinkPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe("AccessLinkPage", () => {
  it("redeems the PIN and lands the user in the bound project", async () => {
    redeemMock.mockResolvedValue({
      session: { jwt: "j", username: "translator", createdAt: "now" },
      projectId: "proj-9",
    })
    renderPage()
    fireEvent.change(screen.getByTestId("access-pin-input"), { target: { value: "4821" } })
    fireEvent.click(screen.getByRole("button", { name: /open project/i }))

    await waitFor(() => {
      expect(redeemMock).toHaveBeenCalledWith("tok123", "4821")
      expect(navigate).toHaveBeenCalledWith("/project/proj-9", { replace: true })
    })
    // Onboarding is marked complete so the fresh browser isn't bounced.
    expect(localStorage.getItem("codex:onboardingComplete")).toBe("true")
  })

  it("shows the generic dead-link error on a wrong PIN and does not navigate", async () => {
    redeemMock.mockRejectedValue(
      new FrontierAuthError("This link is invalid or has expired.", 401),
    )
    renderPage()
    fireEvent.change(screen.getByTestId("access-pin-input"), { target: { value: "0000" } })
    fireEvent.click(screen.getByRole("button", { name: /open project/i }))

    await waitFor(() => {
      expect(screen.getByTestId("access-link-error")).toHaveTextContent(
        "This link is invalid or has expired.",
      )
    })
    expect(navigate).not.toHaveBeenCalled()
    // PIN field is cleared for retry.
    expect((screen.getByTestId("access-pin-input") as HTMLInputElement).value).toBe("")
  })
})
