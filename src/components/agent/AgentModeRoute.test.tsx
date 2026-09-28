import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { AgentModeRoute } from "./AgentModeRoute"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderRoute(path: string, desktop: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: desktop,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/project/:id/agent" element={
          <AgentModeRoute><div>Agent workbench</div></AgentModeRoute>
        } />
        <Route path="/project/:id/editor" element={<div>Project editor</div>} />
        <Route path="/project/:id/editor/file/:fileId" element={<div>File editor</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("AgentModeRoute", () => {
  it("keeps the workbench available on desktop", () => {
    renderRoute("/project/p1/agent", true)
    expect(screen.getByText("Agent workbench")).toBeInTheDocument()
  })

  it("returns a phone deep link to its editor file", async () => {
    renderRoute(
      "/project/p1/agent?return=%2Fproject%2Fp1%2Feditor%2Ffile%2Ff1",
      false,
    )
    expect(await screen.findByText("File editor")).toBeInTheDocument()
    expect(screen.queryByText("Agent workbench")).toBeNull()
  })

  it("falls back to the project editor without a return path", async () => {
    renderRoute("/project/p1/agent", false)
    expect(await screen.findByText("Project editor")).toBeInTheDocument()
  })
})
