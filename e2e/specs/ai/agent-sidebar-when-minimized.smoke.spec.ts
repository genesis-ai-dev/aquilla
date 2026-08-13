import { test, expect } from "../../helpers/multi-user"
import { AgentPage } from "../../helpers/page-objects/AgentPage"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Sidebar Agent must open the compact dock panel when the workbench is not
 * the active surface. Minimize dismisses the editor Agent tab and restores
 * the dock; a collapsed rail click also opens the dock, not /agent.
 */
test("sidebar Agent opens the dock after the workbench is minimized", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `AgentDock ${Date.now()}`,
  })
  const ws = await openSeededProject(alice, seeded)
  const agent = new AgentPage(alice)
  const rail = alice.getByRole("complementary")

  await agent.openAgentTab()
  await agent.expectDocked()

  await agent.openFullScreenWorkbench()

  await agent.closeFullScreenWorkbench()
  await ws.waitForEditor()
  await agent.expectWorkbenchTabClosed()
  await agent.expectDocked()

  await rail.getByRole("button", { name: "Files", exact: true }).click()
  await expect(alice.getByRole("button", { name: "Open agent in editor tab" })).toBeHidden()
  await agent.openAgentTab()
  await agent.expectDocked()

  await alice.getByRole("button", { name: "Collapse sidebar" }).click()
  await expect(alice.getByRole("button", { name: "Expand sidebar" })).toBeVisible()

  await agent.openAgentTab()
  await agent.expectDocked()
})
