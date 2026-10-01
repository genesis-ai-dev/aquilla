import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import { AgentPage } from "../../helpers/page-objects/AgentPage"

/**
 * AQU-1496 — the agent workbench must show the file that is open in the editor.
 *
 * It stopped doing so because the compact-viewport guard (AQU-806) was the only
 * route wrapper in the workspace's route table: `<Routes>` reconciles its match
 * by element type at one child slot, so entering `/project/:id/agent` changed
 * that type, React rebuilt `ProjectWorkspace`, and the rebuilt workspace had no
 * open file — both panes rendered "Choose a file · 0 cells". Nothing caught it:
 * the agent-draft journey only asserts the agent's own proposal rows.
 *
 * This is a smoke journey rather than RTL because what regressed only exists
 * when the real route table, the real workspace and the real cell read from
 * sync-worker are composed — the panes list cells fetched over HTTP for the
 * file the SPA believes is open.
 */
test("the agent workbench lists the open file's cells, and keeps them across a reload", async ({ alice }) => {
  // Seed + cold route hydration + a reload of the same surface.
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: "Workbench open file" })
  await openSeededProject(alice, seeded)

  const agent = new AgentPage(alice)
  const sourcePane = alice.getByRole("region", { name: "Source pane" })
  const targetPane = alice.getByRole("region", { name: "Target pane" })
  const expectedCells = seeded.cellIds.length
  expect(expectedCells).toBeGreaterThan(0)

  // Enter through the sidebar Agent panel → "Open agent in editor tab".
  await agent.openAgentTab()
  await agent.openFullScreenWorkbench()

  // The panes list the open file's cells and count them in their headers —
  // this is the step that used to read "Choose a file" / "0 cells".
  for (const pane of [sourcePane, targetPane]) {
    await expect(pane).toContainText(`${expectedCells} cell`)
    await expect(pane.getByText("Choose a file", { exact: true })).toHaveCount(0)
  }
  await expect(
    sourcePane.locator(`[data-cell-id="${seeded.cellIds[0]}"]`),
  ).toBeVisible()
  await expect(
    targetPane.locator(`[data-cell-id="${seeded.cellIds[0]}"]`),
  ).toBeVisible()

  // The status bar no longer claims nothing is open.
  await expect(alice.getByText("No file open", { exact: true })).toHaveCount(0)

  // A reload is a cold mount: no workspace state survives it, so the file has
  // to come back off the URL's `?return=` hand-off.
  await expect(alice).toHaveURL(/\/agent\?.*return=/)
  await alice.reload()
  for (const pane of [sourcePane, targetPane]) {
    await expect(pane).toContainText(`${expectedCells} cell`)
  }
  await expect(
    targetPane.locator(`[data-cell-id="${seeded.cellIds[0]}"]`),
  ).toBeVisible()

  // Switching back to Text returns to the same file, not the bare editor.
  // (Not `closeFullScreenWorkbench` — the collapse affordance belongs to the
  // dock-expanded entry and is legitimately absent after a reload.)
  await alice.getByRole("tab", { name: "Text", exact: true }).click()
  await expect(alice).toHaveURL(new RegExp(`/editor/file/${seeded.fileId}`))
})
