// Smart Extensions: a freshly BUILT extension actually shows up, in every
// mount it declares. The fixture is a real builder output (Claude Opus via
// the builder, prompt: "A side panel that shows the word count of each
// verse's translation and the total for the file, updating live as I type"),
// installed as a builder-origin extension. Its full page renders content; the
// editor's palette opens it in the side panel (also at a narrow width, where
// the dock is a sheet); and its total follows an edit live.
//
// Crosses SPA (sandboxed frame + bridge + palette + dock), auth-worker (tools
// store, grants), sync-worker (reads, the applied-event push), Postgres.

import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.join(__dirname, "../../fixtures/tools/word-count-built.html")
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const AUTH = process.env.VITE_AUTH_BASE ?? "http://127.0.0.1:8787"
const NAME = "Word Count"

test("a freshly built extension renders in its full page and in the side panel, and updates live", async ({ alice }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Built ${Date.now()}`, fixturePath: FIXTURE })
  const source = await readFile(SOURCE, "utf8")
  const manifest = { name: NAME, description: "Word count per verse and for the file, live.", scopes: ["read:cells"], mounts: ["panel", "page"], apiRev: 3 }
  const res = await fetch(`${AUTH}/api/v2/projects/${seeded.projectId}/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ source, manifest, origin: "builder", grant: ["read:cells"] }),
  })
  expect(res.status, await res.clone().text()).toBe(201)
  const toolId = ((await res.json()) as { tool: { id: string } }).tool.id
  const tools = new ToolsPage(alice)

  // Full page: the frame shows its UI and the file's numbers (not a blank body).
  await alice.goto(`/project/${seeded.projectId}/extensions/${toolId}`)
  const page = tools.toolFrame(NAME)
  await expect(page.locator("body")).toContainText("words", { timeout: 30_000 })
  await expect(page.locator("body")).toContainText("MAT 1:1")
  await expect(alice.getByTestId("extension-blank")).toHaveCount(0)

  // Side panel, opened from the editor's palette button.
  await alice.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  const ws = new Workspace(alice)
  await ws.waitForEditor()
  await tools.openInSidePanelFromPalette(NAME)
  const panel = alice.getByTestId("tools-dock-panel").frameLocator(`iframe[title="${NAME} (sandboxed extension)"]`)
  await expect(panel.locator("body")).toContainText("words", { timeout: 30_000 })
  await expect(panel.locator(".total")).toContainText(/^0\s*words/)

  // Live: a translation typed in the editor moves the panel's total.
  await ws.editCell(await ws.cellIndexWithSource("The book of the genealogy"), "Kitabu cha ukoo wa Yesu Kristo")
  await expect(panel.locator(".total")).toContainText(/^6\s*words/, { timeout: 15_000 })

  // Narrow width: the dock is a sheet; the palette still opens the panel.
  await alice.setViewportSize({ width: 533, height: 760 })
  await alice.reload()
  await ws.waitForEditor()
  await tools.openInSidePanelFromPalette(NAME)
  const sheetPanel = alice.getByRole("dialog").getByTestId("tools-dock-panel").frameLocator(`iframe[title="${NAME} (sandboxed extension)"]`)
  await expect(sheetPanel.locator("body")).toContainText("words", { timeout: 30_000 })
})
