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

  it("renders a receipt-only CreateProject summary instead of 'No changes summarized.'", async () => {
    const data = {
      ...APPROVAL_DATA,
      summary: {
        command: "CreateProject",
        projectName: "Brand New",
        newProjectId: "brand-new",
        targetOrg: "10",
        warnings: [],
      },
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(data), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    renderPage()

    expect(await screen.findByText(/command/i)).toBeInTheDocument()
    expect(screen.getByText("CreateProject")).toBeInTheDocument()
    expect(screen.getByText("Brand New")).toBeInTheDocument()
    expect(screen.getByText("brand-new")).toBeInTheDocument()
    expect(screen.queryByText(/No changes summarized/i)).not.toBeInTheDocument()
  })

  it("renders per-key settings previews for an UpdateProjectSettings changeset", async () => {
    const data = {
      ...APPROVAL_DATA,
      summary: {
        command: "UpdateProjectSettings",
        projectId: "proj-1",
        ifMatchVersion: 1,
        settingsChanges: { targetLanguage: "de", validationCount: "5" },
        warnings: [],
      },
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(data), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    renderPage()

    expect(await screen.findByText(/Settings changes/i)).toBeInTheDocument()
    expect(screen.getByText("targetLanguage")).toBeInTheDocument()
    expect(screen.getByText("de")).toBeInTheDocument()
    expect(screen.getByText("validationCount")).toBeInTheDocument()
    expect(screen.queryByText(/No changes summarized/i)).not.toBeInTheDocument()
  })

  it("renders per-cell before/after changes and a back-to-project link", async () => {
    const data = {
      ...APPROVAL_DATA,
      changes: {
        total: 202,
        truncated: true,
        items: [
          {
            fileId: "file-1",
            fileName: "Genesis",
            cellId: "c-a",
            canonicalRef: "GEN 1:1",
            source: "In the beginning",
            before: "Old draft",
            after: "New draft",
          },
          {
            fileId: "file-1",
            fileName: "Genesis",
            cellId: "c-b",
            canonicalRef: "GEN 1:2",
            source: "And the earth",
            before: null,
            after: "Fresh translation",
          },
        ],
      },
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(data), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    renderPage()

    expect(await screen.findByText(/Changes \(202\)/)).toBeInTheDocument()
    expect(screen.getByText(/GEN 1:1/)).toBeInTheDocument()
    expect(screen.getByText("Old draft")).toBeInTheDocument()
    expect(screen.getByText("New draft")).toBeInTheDocument()
    expect(screen.getByText("Fresh translation")).toBeInTheDocument()
    // 202 total, 2 shown — the truncation notice keeps the reviewer honest.
    expect(screen.getByText(/and 200 more changes/i)).toBeInTheDocument()
    const back = screen.getByRole("link", { name: /back to Blackfoot/i })
    expect(back).toHaveAttribute("href", "/project/proj-1")
  })

  it("renders an import preview for a PlanImport changeset", async () => {
    const data = {
      ...APPROVAL_DATA,
      importPreview: {
        fileName: "genesis.usfm",
        fileType: "usfm",
        totalCells: 25,
        sampleCells: [
          { canonicalRef: "GEN 1:1", content: "In the beginning" },
          { canonicalRef: "GEN 1:2", content: "And the earth" },
        ],
      },
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(data), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    renderPage()

    expect(await screen.findByText(/Import preview/i)).toBeInTheDocument()
    expect(screen.getByText(/genesis\.usfm/)).toBeInTheDocument()
    expect(screen.getByText("In the beginning")).toBeInTheDocument()
    expect(screen.getByText(/and 23 more cells/i)).toBeInTheDocument()
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

    // AQU-820: the server's raw message never renders — the keyed 403 sentence does.
    expect(await screen.findByText("You aren't authorized to view this approval.")).toBeInTheDocument()
    expect(screen.queryByText("not your changeset")).not.toBeInTheDocument()
  })
})
