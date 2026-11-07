/**
 * A Paratext project on this computer reads like a cloud project's overview:
 * header, progress, books grouped by how far along they are, team. Progress is
 * counted from the book files themselves, so a verse with no text after its
 * number must not count as written, and "Open project" must lead to the
 * mirrored project's editor once one exists rather than re-importing.
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import type { ReactNode } from "react"
import { bookStatus, summarizeProgress } from "@/lib/paratext-bridge/use-paratext-progress"

const discover = vi.fn()
const readFile = vi.fn()
const link = vi.fn()
vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => true }))
vi.mock("@/lib/paratext-bridge/tauri", () => ({
  paratextTauri: { discover: () => discover(), readFile: (...a: unknown[]) => readFile(...a), userRoots: vi.fn(), addRoot: vi.fn(), removeRoot: vi.fn() },
}))
vi.mock("@/lib/paratext-bridge/store", () => ({ bridgeStore: { link: (g: string) => link(g) } }))
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ main, header }: { main: ReactNode; header: ReactNode }) => <div>{header}{main}</div>,
}))
vi.mock("@/components/this-computer/ThisComputerSidebar", () => ({ ThisComputerSidebar: () => null }))

import { ParatextProjectPage } from "./ParatextProjectPage"

const SETTINGS = `<ScriptureText><Guid>abc</Guid><Name>TPP1</Name><FullName>Test Project</FullName><Language>English</Language><Encoding>65001</Encoding><FileNamePrePart></FileNamePrePart><FileNamePostPart>TPP1.SFM</FileNamePostPart><FileNameBookNameForm>41MAT</FileNameBookNameForm></ScriptureText>`
const ACCESS = `<ProjectUserAccess><User UserName="Ryder"><Role>Administrator</Role><AllBooks>true</AllBooks></User></ProjectUserAccess>`
const PATH = "/Users/u/Projects/TPP1"
const FOUND = {
  roots: [{ path: "/Users/u/Projects", source: "user" }],
  projects: [{ path: PATH, folderName: "TPP1", settingsXml: SETTINGS, userAccessXml: ACCESS, bookFiles: ["41MATTPP1.SFM"] }],
  registeredUser: { name: "Ryder", email: "r@x" },
  paratextRunning: true,
}
const MAT = new TextEncoder().encode("\\id MAT\n\\c 1\n\\p\n\\v 1 In the beginning\n\\v 2\n\\v 3 More text\n")

beforeEach(() => {
  discover.mockReset().mockResolvedValue(FOUND)
  readFile.mockReset().mockResolvedValue(MAT)
  link.mockReset().mockResolvedValue(null)
})

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{loc.pathname}</div>
}

const renderPage = () => render(
  <MemoryRouter initialEntries={[`/paratext/project?project=${encodeURIComponent(PATH)}`]}>
    <Routes>
      <Route path="/paratext/project" element={<ParatextProjectPage />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
)

describe("book status", () => {
  it("is in progress until every verse has text", () => {
    expect(bookStatus(31, 0)).toBe("not-started")
    expect(bookStatus(31, 12)).toBe("in-progress")
    expect(bookStatus(31, 31)).toBe("complete")
    expect(bookStatus(0, 0)).toBe("not-started")
  })

  it("sums verses across books", () => {
    const b = (code: string, verses: number, written: number) => ({ code, fileName: code, verses, written, status: bookStatus(verses, written), unreadable: false })
    expect(summarizeProgress([b("GEN", 10, 4), b("EXO", 5, 5)])).toMatchObject({ verses: 15, written: 9 })
  })
})

describe("ParatextProjectPage", () => {
  it("counts only verses that have text, and groups the book by status", async () => {
    renderPage()
    const header = await screen.findByTestId("paratext-project-header")
    expect(within(header).getByText("Test Project")).toBeInTheDocument()
    expect(within(header).getByText("Not in Aquilla yet")).toBeInTheDocument()
    // Three verses, one empty: the book is in progress at 2 of 3.
    const inProgress = await screen.findByTestId("paratext-books-in-progress")
    await waitFor(() => expect(within(inProgress).getByText("2 of 3")).toBeInTheDocument())
    expect(within(screen.getByTestId("paratext-books-complete")).queryByRole("link")).toBeNull()
  })

  it("shows Paratext's roles in the team card", async () => {
    renderPage()
    const team = await screen.findByTestId("paratext-team-card")
    expect(within(team).getByText("Ryder")).toBeInTheDocument()
    expect(within(team).getByText("Administrator")).toBeInTheDocument()
  })

  it("opens the mirrored project's editor once the project is in Aquilla", async () => {
    link.mockResolvedValue({ projectGuid: "abc", projectPath: PATH, projectId: "p-1", books: { MAT: { fileId: "f-9", fileName: "41MATTPP1.SFM" } }, targetLang: "", createdAt: 0 })
    renderPage()
    await waitFor(() => expect(screen.getByTestId("paratext-link-badge")).toHaveTextContent("In Aquilla"))
    screen.getByTestId("paratext-open-in-aquilla").click()
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/project/p-1/editor/file/f-9"))
  })

  it("says so when the project is no longer on this computer", async () => {
    discover.mockResolvedValue({ ...FOUND, projects: [] })
    renderPage()
    expect(await screen.findByTestId("paratext-project-missing")).toBeInTheDocument()
  })
})
