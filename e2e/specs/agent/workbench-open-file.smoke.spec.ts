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
 * open file — the workbench rendered "Choose a file · 0 cells". Nothing caught
 * it: the agent-draft journey only asserts the agent's own proposal rows.
 *
 * This is a smoke journey rather than RTL because what regressed only exists
 * when the real route table, the real workspace and the real cell read from
 * sync-worker are composed — the Document view lists cells fetched over HTTP
 * for the file the SPA believes is open.
 *
 * The workbench shows that file as ONE paired document (source beside target,
 * a row per cell) under the Team conversation's Document tab; the separate
 * Source and Target panes this journey first asserted are gone.
 */
test("the agent workbench lists the open file's cells, and keeps them across a reload", async ({ alice }) => {
  // Seed + cold route hydration + a reload of the same surface.
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: "Workbench open file" })
  await openSeededProject(alice, seeded)

  const agent = new AgentPage(alice)
  const documentView = alice.getByTestId("agent-document-context")
  const firstRow = documentView.locator(`article[data-cell-id="${seeded.cellIds[0]}"]`)
  const expectedCells = seeded.cellIds.length
  expect(expectedCells).toBeGreaterThan(0)

  // Enter through the sidebar Agent panel → "Open agent in editor tab", then
  // open the Team conversation's Document view.
  await agent.openAgentTab()
  await alice.getByRole("tab", { name: "Document", exact: true }).click()

  // The document lists the open file's cells and counts them in its header —
  // this is the step that used to read "Choose a file" / "0 cells". Its empty
  // state is the only place the view offers a file as its title.
  await expect(documentView).toContainText(`${expectedCells} cell`)
  await expect(documentView.getByRole("heading", { name: "Choose file", exact: true })).toHaveCount(0)
  await expect(firstRow).toBeVisible()

  // The status bar no longer claims nothing is open.
  await expect(alice.getByText("No file open", { exact: true })).toHaveCount(0)

  // A reload is a cold mount: no workspace state survives it, so the file has
  // to come back off the URL's `?return=` hand-off.
  await expect(alice).toHaveURL(/\/agent\?.*return=/)
  await alice.reload()
  await expect(documentView).toContainText(`${expectedCells} cell`)
  await expect(firstRow).toBeVisible()

  // Switching back to Text returns to the same file, not the bare editor.
  // (Not `closeFullScreenWorkbench` — the collapse affordance belongs to the
  // dock-expanded entry and is legitimately absent after a reload.)
  await alice.getByRole("tab", { name: "Text", exact: true }).click()
  await expect(alice).toHaveURL(new RegExp(`/editor/file/${seeded.fileId}`))
})
