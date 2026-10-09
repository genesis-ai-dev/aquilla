// Smart Extensions SDK (window.aq, manifest sdk: 1): extensions written in a
// few lines from the SDK's hooks, UI kit and the editor's own components.
// A "verse cards" page (one card per verse: source, the real translation
// editor and the validate button) edits and validates through the bridge; a
// word-count side panel follows the file open in the editor and updates live.
//
// Crosses SPA (sandboxed frame + bridge + SDK injection + dock), auth-worker
// (tools store, manifest sdk validation, grants), sync-worker (reads, writes
// with tool provenance, the applied-event push), Postgres.

import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, "../../fixtures/tools")
const USFM = path.join(FIXTURES, "key-terms.usfm")
const AUTH = process.env.VITE_AUTH_BASE ?? "http://127.0.0.1:8787"

async function install(jwt: string, projectId: string, file: string, manifest: Record<string, unknown>, grant: string[]): Promise<string> {
  const source = await readFile(path.join(FIXTURES, file), "utf8")
  const res = await fetch(`${AUTH}/api/v2/projects/${projectId}/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ source, manifest: { apiRev: 4, sdk: 1, ...manifest }, origin: "builder", grant }),
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { tool: { id: string } }).tool.id
}

test("SDK extensions: verse cards edit and validate; a word-count panel follows the open file live", async ({ alice }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `SDK ${Date.now()}`, fixturePath: USFM })
  const write = ["read:cells", "write:target", "write:validation"]
  const cardsId = await install(jwt, seeded.projectId, "sdk-verse-cards.html", { name: "Verse Cards", description: "One card per verse.", scopes: write, mounts: ["page"] }, write)
  await install(jwt, seeded.projectId, "sdk-word-count.html", { name: "Words", description: "Word count, live.", scopes: ["read:cells"], mounts: ["page", "panel"] }, ["read:cells"])
  const tools = new ToolsPage(alice)

  // Verse cards: source + the real translation editor + validation, per verse.
  await alice.goto(`/project/${seeded.projectId}/extensions/${cardsId}`)
  const cards = tools.toolFrame("Verse Cards")
  const card = cards.locator('[data-cell-id] .k-card').filter({ hasText: "MAT 1:1" })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.locator("[data-editor-cell-surface=source]")).toContainText("The book of the genealogy")
  const box = card.locator("[data-target-read-view]")
  await box.click()
  await expect(box).toHaveAttribute("contenteditable", "true")
  await alice.keyboard.type("Kitabu cha ukoo wa Yesu Kristo")
  await alice.keyboard.press("Enter")
  await expect(card.locator(".saved")).toBeVisible({ timeout: 15_000 })
  const validate = card.locator("[data-testid=validation-gutter] button")
  await expect(validate).toHaveAttribute("aria-pressed", /true|false/)
  if ((await validate.getAttribute("aria-pressed")) === "false") await validate.click()
  await expect(validate).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 })

  // The word-count panel, opened from the editor's palette, counts the open file and follows an edit.
  await alice.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  const ws = new Workspace(alice)
  await ws.waitForEditor()
  await tools.openInSidePanelFromPalette("Words")
  const panel = alice.getByTestId("tools-dock-panel").frameLocator('iframe[title="Words (sandboxed extension)"]')
  await expect(panel.locator(".k-stat-v")).toHaveText("6", { timeout: 30_000 })
  await ws.editCell(await ws.cellIndexWithSource("Abraham was the father of Isaac"), "Abrahamu akamzaa Isaka")
  await expect(panel.locator(".k-stat-v")).toHaveText("9", { timeout: 15_000 })
})
