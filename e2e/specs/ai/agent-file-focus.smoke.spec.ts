import { test } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { AgentPage } from "../../helpers/page-objects/AgentPage"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHAPTER_1 = path.resolve(__dirname, "../../fixtures/chapter-1.md")
const CHAPTER_2 = path.resolve(__dirname, "../../fixtures/chapter-2.md")

test("agent file picker keeps the workbench open and updates source and target context", async ({ alice }) => {
  test.setTimeout(120_000)
  const dashboard = new Dashboard(alice)
  await dashboard.goto()
  const projectName = `Agent focus ${Date.now()}`
  await dashboard.createProject({ name: projectName, source: "en", target: "it" })
  await dashboard.openProject(projectName)

  const workspace = new Workspace(alice)
  const agent = new AgentPage(alice)
  await workspace.importFile(CHAPTER_1)
  await workspace.importFile(CHAPTER_2)
  await workspace.openFileBySubstring("chapter-1")
  await workspace.waitForEditor()

  await agent.openAgentTab()
  await agent.openFullScreenWorkbench()
  await agent.expectThreePaneWorkbench()
  await agent.chooseWorkbenchFile("chapter-2")
  await agent.expectWorkbenchFile(/chapter-2/i, "This is the second chapter")
})
