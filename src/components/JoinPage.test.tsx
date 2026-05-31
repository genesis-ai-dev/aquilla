import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { JoinPage } from "./JoinPage"
import { acceptServerInvite, previewMultiInvite, acceptMultiInvite } from "@/lib/sync/invites"

const navigate = vi.fn()
vi.mock("react-router-dom", async (i) => ({
  ...(await i<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))

vi.mock("@/lib/sync/invites", () => ({
  acceptServerInvite: vi.fn(async () => ({ projectId: "p1" })),
  previewServerInvite: vi.fn(async () => ({ projectName: "John", role: { level: 400, name: "contributor" }, email: null })),
  previewMultiInvite: vi.fn(async () => null),
  acceptMultiInvite: vi.fn(async () => null),
}))

let sessionValue: { session: { jwt: string } | null; loading: boolean } = { session: null, loading: false }
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => sessionValue }))

vi.mock("@/components/git-import/FrontierSignupForm", () => ({
  FrontierSignupForm: ({ onSuccess }: { onSuccess: () => void }) => <button onClick={onSuccess}>do-signup</button>,
}))
vi.mock("@/components/git-import/FrontierLoginForm", () => ({
  FrontierLoginForm: ({ onSuccess }: { onSuccess: () => void }) => <button onClick={onSuccess}>do-login</button>,
}))
vi.mock("@/components/git-import/FrontierForgotPasswordForm", () => ({
  FrontierForgotPasswordForm: () => <div />,
}))

function renderJoin() {
  return render(
    <MemoryRouter initialEntries={["/join/tok"]}>
      <Routes><Route path="/join/:token" element={<JoinPage />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  sessionValue = { session: null, loading: false }
  vi.clearAllMocks()
})

describe("JoinPage inline auth", () => {
  it("shows inline auth (no bounce to /) when signed out", async () => {
    renderJoin()
    expect(await screen.findByText("John")).toBeInTheDocument()
    expect(screen.getByText("do-login")).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalledWith("/")
  })

  it("redeems automatically once a session exists", async () => {
    sessionValue = { session: { jwt: "jwt" }, loading: false }
    renderJoin()
    await waitFor(() => expect(acceptServerInvite).toHaveBeenCalledWith("jwt", "tok"))
    expect(navigate).toHaveBeenCalledWith("/project/p1")
  })

  it("shows a multi-project preview (N projects) when signed out", async () => {
    vi.mocked(previewMultiInvite).mockResolvedValueOnce({
      token: "tok",
      role: { level: 400, name: "contributor" },
      expiresAt: null,
      projects: [
        { projectId: "pa", projectName: "John", archived: false },
        { projectId: "pb", projectName: "Mark", archived: false },
      ],
    })
    renderJoin()
    expect(await screen.findByText("John")).toBeInTheDocument()
    expect(screen.getByText("Mark")).toBeInTheDocument()
    expect(screen.getByText("do-login")).toBeInTheDocument() // inline auth still shows
  })

  it("redeems a multi-project token via acceptMultiInvite", async () => {
    vi.mocked(previewMultiInvite).mockResolvedValueOnce({
      token: "tok",
      role: { level: 400, name: "contributor" },
      expiresAt: null,
      projects: [{ projectId: "pa", projectName: "John", archived: false }],
    })
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({
      token: "tok",
      accepted: [{ projectId: "pa", role: 400 }, { projectId: "pb", role: 400 }],
    })
    sessionValue = { session: { jwt: "jwt" }, loading: false }
    renderJoin()
    await waitFor(() => expect(acceptMultiInvite).toHaveBeenCalledWith("jwt", "tok"))
    expect(navigate).toHaveBeenCalledWith("/project/pa") // first accepted project
  })
})
