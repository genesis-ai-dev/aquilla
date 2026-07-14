import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { ApproveChangeset } from "./ApproveChangeset"

let sessionValue: { session: { jwt: string } | null; loading: boolean } = {
  session: { jwt: "test-jwt" },
  loading: false,
}
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => sessionValue,
}))

const APPROVAL_DATA = {
  changesetId: "cs-1",
  projectId: "proj-1",
  projectName: "Blackfoot",
  status: "staged",
  autonomyMode: "ask",
  summary: {
    translationsAdded: 3,
    translationsModified: 1,
    warnings: [{ message: "term 'covenant' rendered 3 ways" }],
  },
  digest: "sha256:0123456789abcdef0123456789abcdef",
  createdAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-14T00:00:00.000Z",
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/approve/cs-1"]}>
      <Routes>
        <Route path="/approve/:changesetId" element={<ApproveChangeset />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  sessionValue = { session: { jwt: "test-jwt" }, loading: false }
  vi.restoreAllMocks()
})

describe("ApproveChangeset", () => {
  it("renders the server-computed summary facts from the GET", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/api/v2/changesets/cs-1/approval")
      return new Response(JSON.stringify(APPROVAL_DATA), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)

    renderPage()

    expect(await screen.findByText("Blackfoot")).toBeInTheDocument()
    expect(screen.getByText(/translations added/i)).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
    expect(screen.getByText(/translations modified/i)).toBeInTheDocument()
    expect(screen.getByText(/covenant/i)).toBeInTheDocument()
  })

  it("approve POSTs the digest fetched from GET and shows the success state", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/approval")) {
        return new Response(JSON.stringify(APPROVAL_DATA), { status: 200 })
      }
      if (url.endsWith("/approve")) {
        const body = JSON.parse(String(init?.body)) as { digest: string }
        expect(body.digest).toBe(APPROVAL_DATA.digest)
        return new Response(
          JSON.stringify({ confirmationId: "conf-1", expiresAt: "2026-07-13T00:15:00.000Z" }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    renderPage()
    await screen.findByText("Blackfoot")

    screen.getByRole("button", { name: /approve/i }).click()

    await waitFor(() => {
      expect(screen.getByText(/return to your agent/i)).toBeInTheDocument()
    })
  })

  it("shows a not-authorized message on 403", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: { code: "permission_denied", message: "not your changeset" } }),
        { status: 403 },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    renderPage()

    expect(await screen.findByText("not your changeset")).toBeInTheDocument()
  })
})
