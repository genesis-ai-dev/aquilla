import { test, expect } from "../../helpers/multi-user"
import { AgentPage } from "../../helpers/page-objects/AgentPage"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Agent-mode-v2 journey: ask the agent to draft the open file, watch the
 * draft tool chip land inline in the run timeline, expand to an editor tab
 * workbench, and accept the staged drafts from the working set — the applied
 * text must reach the editor through the normal outbox path. Then UNDO the
 * applied proposal from its receipt: compensating commits restore each cell's
 * pre-draft value through the same outbox path (rollback is compensation,
 * not deletion).
 *
 * The model is scripts/mock-openrouter.ts (booted by e2e-up and wired via
 * OPENROUTER_BASE_URL): "draft…" → the semantic draft tool → its internal
 * drafting call returns deterministic "[bozza] <source>" values.
 */
test("agent drafts the open file; workbench accept-all lands in the editor; undo restores", async ({ alice }) => {
  // Import + agent run + apply + sync round-trip busts the 30s default.
  test.setTimeout(120_000)
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Agent ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "it" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  const agent = new AgentPage(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the agent dock tab and send a draft prompt.
  await agent.openAgentTab()
  await agent.sendPrompt("draft this file")

  // The run timeline shows the draft tool chip and then a staged proposal
  // card — nothing is written yet.
  await expect(alice.getByText("target.cell.commit").first()).toBeVisible({ timeout: 30_000 })

  // Expand into an editor tab — the SAME session renders there.
  await agent.openFullScreenWorkbench()

  // The working set shows the staged drafts as pending rows; accept them all.
  const acceptAll = alice.getByRole("button", { name: /Accept remaining/ })
  await expect(acceptAll).toBeVisible({ timeout: 10_000 })

  // AQU-846: each pending row names the file it lands in, so accepting is
  // never a blind write into a file the user isn't looking at.
  await expect(alice.locator('[data-row-index="0"]')).toContainText(/sample/i)

  await acceptAll.click()
  await expect(acceptAll).toBeHidden({ timeout: 15_000 })

  // Close workbench returns to the last open file so we can confirm the
  // applied draft reached the editor through the outbox.
  await agent.closeFullScreenWorkbench()
  await ws.waitForEditor()
  await agent.expectWorkbenchTabClosed()
  await expect(ws.cellRow(0)).toContainText("[bozza]", { timeout: 15_000 })

  // Undo lives on the workbench receipt (the dock renders ProposalCard, not
  // ProposalReceipt). Re-open the same session and compensate from there.
  await agent.openFullScreenWorkbench()
  const undo = alice.getByRole("button", { name: /Undo applied/ })
  await expect(undo).toBeVisible({ timeout: 10_000 })
  await undo.click()
  await expect(alice.getByText(/\d+ undone/)).toBeVisible({ timeout: 15_000 })
  await expect(undo).toBeHidden()

  await agent.closeFullScreenWorkbench()
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).not.toContainText("[bozza]", { timeout: 15_000 })
})
