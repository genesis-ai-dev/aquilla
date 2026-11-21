/**
 * "Open project" on a Paratext project must make ONE Aquilla project and link
 * it. Reported from the desktop app (v0.2.5): every click made a new Aquilla
 * project and none was linked. Two ways that happened:
 *
 * - The one-shot setup effect was cancelled when the org or session finished
 *   loading. The cloud project was already created by then, so the page sat on
 *   "Creating" forever and the import (which writes the link) never ran.
 * - Leaving at the "pick a source Bible" step and opening again created a
 *   second project, because the first was not remembered.
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { ReactNode } from "react"

const createCloudProject = vi.fn()
const fetchProjectSettingsResult = vi.fn()
const putLink = vi.fn()
const link = vi.fn()
let org: { activeOrgId: number | null; isLoading: boolean } = { activeOrgId: null, isLoading: true }

vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => true }))
vi.mock("@/lib/paratext-bridge/tauri", () => ({
  paratextTauri: {
    discover: async () => FOUND,
    readFile: async (_p: string, f: string) => {
      if (f === "BookNames.xml") throw new Error("ENOENT")
      return new TextEncoder().encode("\\id MAT\n\\c 1\n\\v 1 One.\n")
    },
  },
}))
vi.mock("@/lib/paratext-bridge/store", () => ({ bridgeStore: { link: (id: string) => link(id), putLink: (l: unknown) => putLink(l) } }))
vi.mock("@/lib/paratext-bridge/book-sync", () => ({ setMirrorBase: async () => {} }))
vi.mock("@/lib/sync/cloud-projects", () => ({ createCloudProject: (...a: unknown[]) => createCloudProject(...a) }))
vi.mock("@/lib/sync/project-settings", () => ({
  createProjectLane: async () => ({ kind: "ok", lane: { legacyTag: "en" } }),
  fetchProjectSettings: async () => null,
  fetchProjectSettingsResult: (...a: unknown[]) => fetchProjectSettingsResult(...a),
  renameProjectLane: async () => {},
}))
vi.mock("@/lib/store/project-index", () => ({ createProject: async () => {} }))
vi.mock("@/lib/sync/cqrs-bridge", () => ({ buildFileScopedTokenFetcher: () => async () => null }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "karl" } }) }))
vi.mock("@/context/OrgContext", () => ({ useActiveOrgOptional: () => org }))
vi.mock("@/components/AppShell", () => ({ AppShell: ({ main }: { main: ReactNode }) => <div>{main}</div> }))
vi.mock("@/components/org/OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("@/components/org/OrgBreadcrumb", () => ({ OrgBreadcrumb: () => null }))
vi.mock("@/components/import/ParatextChoice", () => ({
  ParatextChoice: ({ projectId, onImported }: { projectId: string; onImported: (refs: unknown[]) => void }) => (
    <div data-testid="choice" data-project={projectId}>
      <button onClick={() => onImported([{ id: "f-mat", bookCode: "MAT" }])}>import</button>
    </div>
  ),
}))

import { ParatextOpenPage } from "./ParatextOpenPage"
import { resetPendingParatextImportsForTests } from "@/lib/paratext-bridge/pending-import"

const PATH = "/Users/karl/Paratext9Projects/TPP1"
const SETTINGS = `<ScriptureText><Guid>abc</Guid><Name>TPP1</Name><FullName>Test Project</FullName><Language>English</Language><Encoding>65001</Encoding><FileNamePrePart></FileNamePrePart><FileNamePostPart>TPP1.SFM</FileNamePostPart><FileNameBookNameForm>41MAT</FileNameBookNameForm></ScriptureText>`
const FOUND = {
  roots: [{ path: "/Users/karl/Paratext9Projects", source: "default" }],
  projects: [{ path: PATH, folderName: "TPP1", settingsXml: SETTINGS, userAccessXml: null, bookFiles: ["41MATTPP1.SFM"] }],
  registeredUser: null,
  paratextRunning: false,
}

const page = () => (
  <MemoryRouter initialEntries={[`/paratext/open?project=${encodeURIComponent(PATH)}`]}>
    <Routes>
      <Route path="/paratext/open" element={<ParatextOpenPage />} />
      <Route path="*" element={<div data-testid="left" />} />
    </Routes>
  </MemoryRouter>
)

beforeEach(() => {
  localStorage.clear()
  resetPendingParatextImportsForTests()
  createCloudProject.mockReset().mockResolvedValue(undefined)
  fetchProjectSettingsResult.mockReset().mockResolvedValue({ ok: true, value: {} })
  putLink.mockReset().mockResolvedValue(undefined)
  link.mockReset().mockResolvedValue(null)
  org = { activeOrgId: null, isLoading: true }
})

describe("ParatextOpenPage", () => {
  it("reaches the import, in the right org, when the org finishes loading after the page opens", async () => {
    const view = render(page())
    // Nothing is created while the org is still unknown: it would land in the wrong place.
    await new Promise((r) => setTimeout(r, 20))
    expect(createCloudProject).not.toHaveBeenCalled()
    org = { activeOrgId: 7, isLoading: false }
    view.rerender(page())
    await screen.findByTestId("choice")
    expect(createCloudProject).toHaveBeenCalledTimes(1)
    expect(createCloudProject.mock.calls[0][1]).toMatchObject({ orgId: 7 })
    await act(async () => { screen.getByText("import").click() })
    await waitFor(() => expect(putLink).toHaveBeenCalledTimes(1))
    expect(putLink.mock.calls[0][0]).toMatchObject({ projectPath: PATH, books: { MAT: { fileId: "f-mat", fileName: "41MATTPP1.SFM" } } })
  })

  it("keeps going when the session or org object changes mid-setup", async () => {
    org = { activeOrgId: 7, isLoading: false }
    let release: () => void = () => {}
    createCloudProject.mockImplementation(() => new Promise<void>((r) => { release = r }))
    const view = render(page())
    await waitFor(() => expect(createCloudProject).toHaveBeenCalled())
    org = { activeOrgId: 7, isLoading: false } // a fresh context value, same org
    view.rerender(page())
    release()
    await screen.findByTestId("choice")
  })

  it("reuses the Aquilla project it made when the user leaves at the source step and opens again", async () => {
    org = { activeOrgId: 7, isLoading: false }
    const first = render(page())
    const projectId = (await screen.findByTestId("choice")).getAttribute("data-project")
    first.unmount()
    render(page())
    expect((await screen.findByTestId("choice")).getAttribute("data-project")).toBe(projectId)
    expect(createCloudProject).toHaveBeenCalledTimes(1)
  })

  it("makes a new project if the remembered one is gone", async () => {
    org = { activeOrgId: 7, isLoading: false }
    const first = render(page())
    const projectId = (await screen.findByTestId("choice")).getAttribute("data-project")
    first.unmount()
    fetchProjectSettingsResult.mockResolvedValue({ ok: false, status: 404, message: "gone" })
    render(page())
    expect((await screen.findByTestId("choice")).getAttribute("data-project")).not.toBe(projectId)
    expect(createCloudProject).toHaveBeenCalledTimes(2)
  })

  it("forgets the remembered project once it is linked", async () => {
    org = { activeOrgId: 7, isLoading: false }
    render(page())
    await screen.findByTestId("choice")
    await act(async () => { screen.getByText("import").click() })
    await waitFor(() => expect(putLink).toHaveBeenCalled())
    expect(Object.keys(localStorage).filter((k) => k.startsWith("aq.paratext-pending-import"))).toEqual([])
  })
})
