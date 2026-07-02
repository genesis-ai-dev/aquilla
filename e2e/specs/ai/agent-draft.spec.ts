import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Agent-mode-v2 journey: ask the agent to draft the open file, watch the
 * draft tool chip land inline in the run timeline, expand to the full-screen
 * workbench, and accept the staged drafts from the working set — the applied
 * text must reach the editor through the normal outbox path.
 *
 * The model is scripts/mock-openrouter.ts (booted by e2e-up and wired via
 * OPENROUTER_BASE_URL): "draft…" → the semantic draft tool → its internal
 * drafting call returns deterministic "[bozza] <source>" values.
 */
test("agent drafts the open file; workbench accept-all lands in the editor", async ({ alice }) => {
  // Import + agent run + apply + sync round-trip busts the 30s default.
  test.setTimeout(120_000)
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Agent ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "it" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the agent dock tab and send a draft prompt.
  await alice.getByRole("button", { name: "Agent", exact: true }).click()
  const composer = alice.getByRole("textbox", { name: "Ask the agent" })
  await composer.click()
  await composer.pressSequentially("draft this file")
  await alice.keyboard.press("Enter")

  // The run timeline shows the draft tool chip and then a staged proposal
  // card — nothing is written yet.
  await expect(alice.getByText("target.cell.commit").first()).toBeVisible({ timeout: 30_000 })

  // Expand to the full-screen workbench — the SAME session renders there.
  await alice.getByRole("button", { name: "Open full-screen workbench" }).click()
  await expect(alice).toHaveURL(/\/agent$/)

  // The working set shows the staged drafts as pending rows; accept them all.
  const acceptAll = alice.getByRole("button", { name: /Accept all/ })
  await expect(acceptAll).toBeVisible({ timeout: 10_000 })
  await acceptAll.click()
  await expect(acceptAll).toBeHidden({ timeout: 15_000 })

  // Back to the editor: /project/:id restores the last open file (the dock is
  // still on the Agent tab, so don't reach for the file list). The applied
  // draft must be in the first cell.
  await alice.getByRole("button", { name: "Close workbench" }).click()
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText("[bozza]", { timeout: 15_000 })
})
