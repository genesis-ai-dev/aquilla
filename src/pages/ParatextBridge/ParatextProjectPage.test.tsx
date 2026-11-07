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
import { bookStatus, countBook, summarizeProgress, toBookProgress, verseSpan } from "@/lib/paratext-bridge/use-paratext-progress"

const discover = vi.fn()
const readFile = vi.fn()
const link = vi.fn()
vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => true }))
vi.mock("@/lib/paratext-bridge/tauri", () => ({
  paratextTauri: { hashFile: vi.fn().mockResolvedValue("h1"), discover: () => discover(), readFile: (...a: unknown[]) => readFile(...a), userRoots: vi.fn(), addRoot: vi.fn(), removeRoot: vi.fn() },
}))
const hold = vi.fn()
vi.mock("@/lib/paratext-bridge/store", () => ({ bridgeStore: { link: (g: string) => link(g), hold: (g: string, b: string) => hold(g, b) } }))
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
  hold.mockReset().mockResolvedValue(false)
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

  it("measures a canonical book against its standard verse count, not the verses the file lists", () => {
    // Matthew has 1,071 verses; a file with five typed verses is not complete.
    const p = toBookProgress("MAT", "f", { listed: 5, written: 5 }, "4")
    expect(p).toMatchObject({ verses: 1071, written: 5, status: "in-progress" })
    // Another numbering has no standard to compare with: fall back to the file.
    expect(toBookProgress("MAT", "f", { listed: 5, written: 5 }, "2")).toMatchObject({ verses: 5, status: "complete" })
  })

  it("counts a bridged verse as every verse it covers", () => {
    expect(verseSpan("3-5")).toBe(3)
    expect(verseSpan("3a")).toBe(1)
    const unit = (verse: string, text: string) => ({ kind: "verse", chapter: 1, verse, text })
    expect(countBook([unit("1", "a"), unit("2-3", "b"), unit("4", "")])).toEqual({ listed: 4, written: 3 })
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
    // Three verses listed, one empty: two written out of Matthew's 1,071.
    const inProgress = await screen.findByTestId("paratext-books-in-progress")
    await waitFor(() => expect(within(inProgress).getByText("2 of 1071")).toBeInTheDocument())
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

  it("tells the user a mirrored book is waiting on a Paratext reload, and leads to the Aquilla project", async () => {
    link.mockResolvedValue({ projectGuid: "abc", projectPath: PATH, projectId: "p-1", books: { MAT: { fileId: "f-9", fileName: "41MATTPP1.SFM" } }, targetLang: "", createdAt: 0 })
    hold.mockResolvedValue(true)
    renderPage()
    const card = await screen.findByTestId("paratext-mirror-card")
    expect(within(card).getByText("1 / 1")).toBeInTheDocument()
    await waitFor(() => expect(within(card).getByTestId("paratext-mirror-held")).toHaveTextContent("1 book is waiting"))
    expect(within(card).getByText("Open the Aquilla project").closest("a")).toHaveAttribute("href", "/projects/p-1")
  })

  it("shows no mirror card for a project that is not in Aquilla", async () => {
    renderPage()
    await screen.findByTestId("paratext-team-card")
    expect(screen.queryByTestId("paratext-mirror-card")).toBeNull()
  })

  it("says so when the project is no longer on this computer", async () => {
    discover.mockResolvedValue({ ...FOUND, projects: [] })
    renderPage()
    expect(await screen.findByTestId("paratext-project-missing")).toBeInTheDocument()
  })
})
