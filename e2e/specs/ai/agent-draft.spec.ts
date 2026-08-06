import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { AgentPage } from "../../helpers/page-objects/AgentPage"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Agent-mode-v2 journey: ask the agent to draft the open file, watch the
 * draft tool chip land inline in the run timeline, expand to the full-screen
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

  // Expand to the full-screen workbench — the SAME session renders there.
  await agent.openFullScreenWorkbench()
  await agent.expectThreePaneWorkbench()
  await agent.expectAgentTimelineScrollable()
  // The workbench keeps all three surfaces reachable at a narrower width,
  // without adding preset/collapse controls to the header.
  await alice.setViewportSize({ width: 960, height: 720 })
  await agent.expectThreePaneWorkbench()
  await alice.setViewportSize({ width: 1280, height: 720 })

  // The working set shows the staged drafts as pending rows; accept them all.
  const acceptAll = alice.getByRole("button", { name: /Accept remaining/ })
  await expect(acceptAll).toBeVisible({ timeout: 10_000 })
  await acceptAll.click()
  await expect(acceptAll).toBeHidden({ timeout: 15_000 })

  // Back to the editor: /project/:id/editor restores the last open file (the dock is
  // still on the Agent tab, so don't reach for the file list). The applied
  // draft must be in the first cell.
  await agent.closeFullScreenWorkbench()
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText("[bozza]", { timeout: 15_000 })

  // Regret it: back in the workbench, the receipt offers Undo. Compensating
  // commits restore the pre-draft (empty) targets through the outbox; the
  // receipt flips to "undone" and the editor no longer shows the draft.
  await agent.openFullScreenWorkbench()
  const undo = alice.getByRole("button", { name: /Undo applied/ })
  await expect(undo).toBeVisible({ timeout: 10_000 })
  await undo.click()
  await expect(alice.getByText(/\d+ undone/)).toBeVisible({ timeout: 15_000 })
  await expect(undo).toBeHidden()

  await agent.closeFullScreenWorkbench()
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).not.toContainText("[bozza]", { timeout: 15_000 })

  // The target context is not a read-only duplicate: it reuses the normal
  // TranslatedEditor and its authoritative target.cell.commit path. A manual
  // correction made beside the agent must survive the return to the main editor.
  await agent.openFullScreenWorkbench()
  await agent.startNewSession()
  await agent.editFirstWorkbenchTarget("Hand edited beside the agent")
  await agent.closeFullScreenWorkbench()
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText("Hand edited beside the agent", { timeout: 15_000 })
})
