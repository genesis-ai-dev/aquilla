import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BuildFlowResult } from "@/lib/tools/build-flow"
import type { ToolManifest } from "../../../shared/tools/manifest"

/**
 * The guided builder (AQU-1793): Describe → Review & try → Add to project.
 * A ready-made starter opens the same review (never a silent install), the
 * review quotes the user's own words above a live sandboxed preview, and only
 * "Add to project" installs — with reads granted and writes left to ask.
 */

const BUILT: ToolManifest = { name: "Word Count", description: "Word count per verse.", scopes: ["read:cells"], mounts: ["panel", "page"], apiRev: 5 } as ToolManifest

const runBuildFlow = vi.fn<(...args: unknown[]) => Promise<BuildFlowResult>>()
const installTool = vi.fn()

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "j", username: "alice" } }) }))
vi.mock("@/hooks/useProject", () => ({ useProject: () => ({ project: { id: "p1", name: "Matthew" }, roleLevel: 700 }) }))
vi.mock("@/components/tools/ToolsMountContext", () => ({ useToolsMount: () => null }))
vi.mock("@/lib/tools/build-flow", () => ({ runBuildFlow: (...args: unknown[]) => runBuildFlow(...args) }))
vi.mock("@/lib/tools/tools-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/tools-api")>()),
  listTools: async () => [],
  installTool: (...args: unknown[]) => installTool(...args),
}))

const { ToolsPage } = await import("./ToolsPage")

function renderAt(url = "/project/p1/extensions") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/project/:id/extensions" element={<ToolsPage />} />
        <Route path="/project/:id/extensions/:toolId" element={<p>extension page</p>} />
        <Route path="/project/:id/editor" element={<p>editor</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

const ok = (manifest: ToolManifest): BuildFlowResult =>
  ({ ok: true, source: "<!doctype html><p>hi</p>", manifest, model: "m", attempts: 1, cost: 0.1, failures: [] }) as unknown as BuildFlowResult

describe("Smart Extensions builder", () => {
  beforeEach(() => {
    runBuildFlow.mockReset()
    installTool.mockReset()
  })

  it("explains the three steps and starts on Describe", async () => {
    renderAt()
    const steps = await screen.findByTestId("builder-steps")
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Describe"),
      expect.stringContaining("Review & try"),
      expect.stringContaining("Add to project"),
    ])
    expect(within(steps).getByText("Describe").closest("li")).toHaveAttribute("aria-current", "step")
  })

  it("a ready-made starter opens Review & try instead of installing, then installs on Add", async () => {
    installTool.mockResolvedValue({ id: "00000000-0000-0000-0000-000000000001", manifest: { mounts: ["panel", "page"] } })
    renderAt()
    await userEvent.click(await screen.findByRole("button", { name: "Try Key-Term Heat Map" }))
    const review = screen.getByTestId("built-candidate")
    expect(within(review).getByText("Ready-made")).toBeInTheDocument()
    expect(within(review).getByTestId("extension-preview-frame")).toBeInTheDocument()
    expect(within(review).queryByTestId("candidate-request")).toBeNull()
    expect(installTool).not.toHaveBeenCalled()

    await userEvent.click(within(review).getByTestId("candidate-add"))
    await screen.findByText("extension page")
    const [, , body] = installTool.mock.calls[0] as [string, string, { origin: string; grant: string[] }]
    expect(body.origin).toBe("starter")
    expect(body.grant.every((s) => s.startsWith("read:"))).toBe(true)
  })

  it("builds from the user's words + placement, and quotes their words above the preview", async () => {
    runBuildFlow.mockResolvedValue(ok(BUILT))
    renderAt()
    const box = await screen.findByRole("textbox", { name: "What should it do?" })
    await userEvent.click(screen.getByRole("button", { name: "Check that my term for 'grace' is used consistently across all books" }))
    expect(box).toHaveValue("Check that my term for 'grace' is used consistently across all books")
    await userEvent.click(screen.getByRole("tab", { name: "Side panel" }))
    await userEvent.click(screen.getByTestId("builder-build"))

    const review = await screen.findByTestId("built-candidate")
    expect(runBuildFlow.mock.calls[0][0]).toBe(
      "Check that my term for 'grace' is used consistently across all books\n\nIt should appear in the editor's side panel (mount: panel).",
    )
    expect(within(review).getByTestId("candidate-request")).toHaveTextContent(
      "You asked for“Check that my term for 'grace' is used consistently across all books”",
    )
    expect(within(review).getByText("Preview with sample verses")).toBeInTheDocument()
    expect(within(review).getByText("Opens in the editor's side panel, beside the verses.")).toBeInTheDocument()
    expect(within(review).getByTestId("scope-summary")).toHaveTextContent("Read files and cells")
    expect(screen.getByText("Review & try").closest("li")).toHaveAttribute("aria-current", "step")
  })

  it("Discard returns to Describe with the words kept", async () => {
    runBuildFlow.mockResolvedValue(ok(BUILT))
    renderAt()
    await userEvent.type(await screen.findByRole("textbox", { name: "What should it do?" }), "count words")
    await userEvent.click(screen.getByTestId("builder-build"))
    await userEvent.click(await screen.findByRole("button", { name: "Discard" }))
    expect(screen.getByRole("textbox", { name: "What should it do?" })).toHaveValue("count words")
  })

  it("a failed build says so in plain words, with the technical text on request", async () => {
    runBuildFlow.mockResolvedValue({ ok: false, failures: ["TypeError: x is undefined"] } as unknown as BuildFlowResult)
    renderAt()
    await userEvent.type(await screen.findByRole("textbox", { name: "What should it do?" }), "cards")
    await userEvent.click(screen.getByTestId("builder-build"))
    const failure = await screen.findByTestId("builder-failure")
    expect(within(failure).queryByText("TypeError: x is undefined")).toBeNull()
    await userEvent.click(within(failure).getByRole("button", { name: "Technical details" }))
    expect(within(failure).getByText("TypeError: x is undefined")).toBeInTheDocument()
  })

  it("?where=editor (the editor's 'Build your own editor…') preselects the placement", async () => {
    renderAt("/project/p1/extensions?where=editor")
    expect(await screen.findByRole("tab", { name: "As an editor" })).toHaveAttribute("aria-selected", "true")
  })

  it("the build button waits for a description", async () => {
    renderAt()
    expect(await screen.findByTestId("builder-build")).toBeDisabled()
    await waitFor(() => expect(screen.getByRole("textbox", { name: "What should it do?" })).toBeEnabled())
  })
})
