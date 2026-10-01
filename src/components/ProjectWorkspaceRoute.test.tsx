import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { useState, type ReactNode } from "react"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { ProjectWorkspaceRoute } from "./ProjectWorkspaceRoute"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubViewport(desktop: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: desktop,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

function renderRoute(path: string, desktop: boolean) {
  stubViewport(desktop)
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/project/:id/agent" element={
          <ProjectWorkspaceRoute><div>Agent workbench</div></ProjectWorkspaceRoute>
        } />
        <Route path="/project/:id/comments" element={
          <ProjectWorkspaceRoute><div>Comments surface</div></ProjectWorkspaceRoute>
        } />
        <Route path="/project/:id/editor" element={<div>Project editor</div>} />
        <Route path="/project/:id/editor/file/:fileId" element={<div>File editor</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

// AQU-806 redirected the agent surface to the editor on a compact viewport.
// The Team workspace is single-column below `lg`, so that guard is gone: a
// phone keeps its Agent URL, hand-off and all.
describe("ProjectWorkspaceRoute — Agent stays reachable on a compact viewport", () => {
  it("keeps the workbench available on desktop", () => {
    renderRoute("/project/p1/agent", true)
    expect(screen.getByText("Agent workbench")).toBeInTheDocument()
  })

  it("keeps a phone deep link on the agent surface instead of returning it to its editor file", () => {
    renderRoute(
      "/project/p1/agent?return=%2Fproject%2Fp1%2Feditor%2Ffile%2Ff1",
      false,
    )
    expect(screen.getByText("Agent workbench")).toBeInTheDocument()
    expect(screen.queryByText("File editor")).toBeNull()
  })

  it("keeps a bare phone agent URL on the agent surface", () => {
    renderRoute("/project/p1/agent", false)
    expect(screen.getByText("Agent workbench")).toBeInTheDocument()
    expect(screen.queryByText("Project editor")).toBeNull()
  })

  it("renders the other surfaces on a phone", () => {
    renderRoute("/project/p1/comments", false)
    expect(screen.getByText("Comments surface")).toBeInTheDocument()
  })
})

// AQU-1496: the workbench lost the open file because `<Routes>` reconciles its
// match by element TYPE at one child slot. Wrapping the agent route alone
// changed that type on an editor → agent hop, so React unmounted the workspace
// and mounted a fresh one with no file. These two cases pin the mechanism.
describe("ProjectWorkspaceRoute — workspace instance survives a surface hop", () => {
  let mounts = 0

  function Workspace() {
    const [mountId] = useState(() => ++mounts)
    const navigate = useNavigate()
    return (
      <div>
        <span data-testid="mount-id">{mountId}</span>
        <button onClick={() => navigate("/project/p1/agent")}>to agent</button>
      </div>
    )
  }

  async function hopToAgent(wrapEditor: boolean) {
    mounts = 0
    stubViewport(true)
    const wrap = (node: ReactNode) =>
      <ProjectWorkspaceRoute>{node}</ProjectWorkspaceRoute>
    render(
      <MemoryRouter initialEntries={["/project/p1/editor"]}>
        <Routes>
          <Route
            path="/project/:id/editor"
            element={wrapEditor ? wrap(<Workspace />) : <Workspace />}
          />
          <Route path="/project/:id/agent" element={wrap(<Workspace />)} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId("mount-id").textContent).toBe("1")
    await act(async () => { screen.getByText("to agent").click() })
    return screen.getByTestId("mount-id").textContent
  }

  it("keeps the instance when every workspace surface shares the wrapper", async () => {
    expect(await hopToAgent(true)).toBe("1")
  })

  it("remounts when only the agent surface is wrapped (the AQU-1496 regression)", async () => {
    expect(await hopToAgent(false)).toBe("2")
  })
})

describe("App route table", () => {
  it("wraps every ProjectWorkspace route in ProjectWorkspaceRoute", () => {
    const app = readFileSync(join(__dirname, "..", "App.tsx"), "utf8")
    const occurrences = app.match(/<ProjectWorkspace \/>/g) ?? []
    expect(occurrences.length).toBeGreaterThan(1)
    // Each one must sit inside the shared wrapper — an unwrapped sibling is
    // exactly what remounted the workspace and emptied the workbench.
    const wrapped = app.match(
      /<ProjectWorkspaceRoute><ProjectWorkspace \/><\/ProjectWorkspaceRoute>/g,
    ) ?? []
    expect(wrapped.length).toBe(occurrences.length)
  })
})
