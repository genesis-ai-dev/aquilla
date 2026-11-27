import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import type { ToolsMountValue } from "./ToolsMountContext"

let mockCtx: Partial<ToolsMountValue> | null = null

vi.mock("./ToolsMountContext", () => ({
  useToolsMount: () => mockCtx,
  useMountedTool: () => ({ tool: null, error: null }),
}))
vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: { id: "p1", name: "Matthew" }, roleLevel: 700 }),
}))

const { ExtensionExports } = await import("./ExtensionExports")
const { InlineToolsTab, ToolsDockPanel, useHasInlineTools } = await import("./ToolMounts")
const { ExtensionsBar } = await import("./ExtensionsBar")

function LocationEcho() {
  const loc = useLocation()
  return <p data-testid="navigated-to">{`${loc.pathname}${loc.search}`}</p>
}

function makeCtx(overrides: Partial<ToolsMountValue> = {}): Partial<ToolsMountValue> {
  return {
    projectId: "p1",
    tools: [],
    pinned: [],
    dockSelection: null,
    setDockSelection: vi.fn(),
    openInPanel: vi.fn(),
    paletteOpen: false,
    setPaletteOpen: vi.fn(),
    runAction: vi.fn(),
    runExport: vi.fn(),
    columnPrefs: {},
    setColumnPref: vi.fn(),
    extensionsEnabled: true,
    ...overrides,
  }
}

describe("Contextual Smart Extension creation triggers", () => {
  it("ExtensionExports renders '+ Build a custom export format…' when enabled even with 0 exporters, and nothing when off", async () => {
    mockCtx = makeCtx({ extensionsEnabled: false })
    const { rerender } = render(
      <MemoryRouter initialEntries={["/project/p1/editor/file/f1"]}>
        <ExtensionExports projectId="p1" fileId="f1" lane="es" getToken={async () => "tok"} />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId("build-extension-exporter")).toBeNull()

    const onBeforeNavigate = vi.fn()
    mockCtx = makeCtx({ extensionsEnabled: true })
    rerender(
      <MemoryRouter initialEntries={["/project/p1/editor/file/f1"]}>
        <Routes>
          <Route
            path="/project/p1/editor/file/f1"
            element={<ExtensionExports projectId="p1" fileId="f1" lane="es" getToken={async () => "tok"} onBeforeNavigate={onBeforeNavigate} />}
          />
          <Route path="/project/:id/extensions" element={<LocationEcho />} />
        </Routes>
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByTestId("build-extension-exporter"))
    expect(onBeforeNavigate).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("navigated-to")).toHaveTextContent("/project/p1/extensions?where=exporter&fileId=f1")
  })

  it("ToolsDockPanel offers '+ Build a side panel…' linking to ?where=panel&fileId=f1", () => {
    mockCtx = makeCtx({ extensionsEnabled: true, tools: [] })
    render(
      <MemoryRouter>
        <ToolsDockPanel file={{ fileId: "f1", name: "MAT" }} />
      </MemoryRouter>,
    )
    expect(screen.getByTestId("build-extension-panel")).toHaveAttribute("href", "/project/p1/extensions?where=panel&fileId=f1")
    expect(screen.getByTestId("build-extension-panel-empty")).toHaveAttribute("href", "/project/p1/extensions?where=panel&fileId=f1")
  })

  it("InlineToolsTab links to ?where=inline&fileId=f1 and useHasInlineTools follows extensionsEnabled", () => {
    function Probe() {
      const has = useHasInlineTools()
      return <span data-testid="has-inline">{String(has)}</span>
    }

    mockCtx = makeCtx({ extensionsEnabled: false, tools: [] })
    const { rerender } = render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    )
    expect(screen.getByTestId("has-inline")).toHaveTextContent("false")

    mockCtx = makeCtx({ extensionsEnabled: true, tools: [] })
    rerender(
      <MemoryRouter>
        <Probe />
        <InlineToolsTab fileId="f1" cellId="c1" />
      </MemoryRouter>,
    )
    expect(screen.getByTestId("has-inline")).toHaveTextContent("true")
    expect(screen.getByTestId("build-extension-inline")).toHaveAttribute("href", "/project/p1/extensions?where=inline&fileId=f1")
  })

  it("ExtensionsBar offers '+ Add column or check' navigating to ?where=column&fileId=f1", async () => {
    mockCtx = makeCtx({
      extensionsEnabled: true,
      tools: [
        {
          id: "t1",
          name: "Companion",
          manifest: { name: "Companion", description: "", scopes: ["read:cells"], mounts: ["page", "panel"], apiRev: 8 },
          currentVersion: 1,
          codeHash: "h",
          origin: "starter",
          upstreamToolId: null,
          grantedScopes: ["read:cells"],
          firstParty: null,
        } as unknown as ToolsMountValue["tools"][number],
      ],
    })
    const choice = {
      editors: [],
      selected: "standard",
      choose: vi.fn(),
      pending: false,
      projectDefault: "standard",
      failure: null,
      reportFailure: vi.fn(),
      retry: vi.fn(),
    }
    render(
      <MemoryRouter initialEntries={["/project/p1/editor/file/f1"]}>
        <Routes>
          <Route path="/project/p1/editor/file/f1" element={<ExtensionsBar choice={choice} fileId="f1" />} />
          <Route path="/project/:id/extensions" element={<LocationEcho />} />
        </Routes>
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByTestId("build-extension-column"))
    expect(screen.getByTestId("navigated-to")).toHaveTextContent("/project/p1/extensions?where=column&fileId=f1")
  })
})
