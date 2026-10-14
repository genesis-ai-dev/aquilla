import { test, expect, type Page } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { resetBackend } from "../../helpers/seed"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Smart Extensions builder — one screenshot per state, for the before/after
 * design review (AQU-1793). Build calls are intercepted with a real builder
 * output (word count panel), a slow response (progress) and a failing one, so
 * every state is deterministic. Writes `${SHOTS_DIR}/${SHOTS_PREFIX}<state>.png`.
 *
 *   SHOTS_DIR=… SHOTS_PREFIX=aqu-1793-builder-before- npm run record -- e2e/recordings/specs/extension-builder-shots.showcase.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const BUILT = path.join(__dirname, "../../fixtures/tools/word-count-built.html")
const AUTH_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
const SHOTS_DIR = process.env.SHOTS_DIR ?? path.join(__dirname, "../output")
const PREFIX = process.env.SHOTS_PREFIX ?? "aqu-1793-builder-"
const FRAME = { width: 1280, height: 800 }

test.use({ viewport: FRAME, colorScheme: process.env.SHOTS_DARK ? "dark" : "light" })

const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: path.join(SHOTS_DIR, `${PREFIX}${name}.png`), fullPage })

const BUILT_MANIFEST = { name: "Word Count", description: "Word count per verse and for the file, live.", scopes: ["read:cells"], mounts: ["panel", "page"], apiRev: 5 }
const usage = { promptTokens: 9000, completionTokens: 2400, cost: 0.21 }

const BROKEN = `<!doctype html><html><body><h1>Verse cards</h1><script>
(async () => { const files = await aquilla.files.list(); const cells = await aquilla.cells.list(files[0].fileId); document.body.append(cells[0].missing.text) })()
</script></body></html>`

const FILLER = `<!doctype html><html><body style="font-family:system-ui;padding:16px">
<h1 style="font-size:18px">Fill the first verse</h1><p>Writes a sample translation into the first verse of the first file.</p>
<button id="b">Fill the first verse</button><p id="out"></p><script>
document.getElementById("b").onclick = async () => {
  const files = await aquilla.files.list(); const cells = await aquilla.cells.list(files[0].fileId)
  const first = cells.find((c) => c.ref)
  try { await aquilla.cells.commit([{ fileId: files[0].fileId, cellId: first.cellId, value: "Libro de la genealogía de Jesucristo." }]); document.getElementById("out").textContent = "Done." }
  catch (e) { document.getElementById("out").textContent = String(e.message || e) }
}
</script></body></html>`

async function install(jwt: string, projectId: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${AUTH_BASE}/api/v2/projects/${projectId}/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { tool: { id: string } }).tool.id
}

test("Smart Extensions builder — every state", async ({ page }) => {
  test.setTimeout(240_000)
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173" }])
  await page.goto("/")
  await injectSession(page, session)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { smartExtensions: true, name: "Matthew (Spanish)", fixturePath: FIXTURE })
  const built = await readFile(BUILT, "utf8")

  // 1. The page as a first-time user finds it.
  await page.goto(`/project/${seeded.projectId}/extensions`)
  const box = page.getByRole("textbox", { name: "Describe your extension" })
  await expect(box).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1500)
  await shot(page, "01-empty", true)

  // 2. Typing a description.
  const request = "A side panel that shows the word count of each verse's translation and the total for the file, updating live as I type"
  await box.fill(request)
  await shot(page, "02-typing")

  // 3. Building (a slow build so the progress state is on screen).
  let release: () => void = () => {}
  const held = new Promise<void>((r) => { release = r })
  await page.route(/\/tools\/build$/, async (route) => {
    await held
    await route.fulfill({ json: { ok: true, source: built, manifest: BUILT_MANIFEST, model: "anthropic/claude-opus-5.5", usage } })
  })
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(page.getByTestId("tool-build-progress")).toBeVisible()
  await page.waitForTimeout(1200)
  await shot(page, "03-building")

  // 4. Built: review before installing.
  release()
  await expect(page.getByTestId("built-candidate")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("extension-preview-frame")).toBeVisible()
  await page.waitForTimeout(1500)
  await shot(page, "04-built", true)
  await page.unroute(/\/tools\/build$/)

  // 5. A build that fails every attempt.
  await page.getByRole("button", { name: /discard/i }).first().click()
  await page.route(/\/tools\/build$/, (route) => route.fulfill({ json: {
    ok: false, failure: "The smoke render threw: TypeError: Cannot read properties of undefined (reading 'text')", source: BROKEN, manifestJson: "{}", lint: [], model: "anthropic/claude-opus-5.5", usage,
  } }))
  await box.fill("Show each verse as a card with its key terms highlighted")
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(page.getByTestId("builder-failure")).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(400)
  await shot(page, "05-build-failed", true)
  await page.unroute(/\/tools\/build$/)

  // 6. Installed list + the extension's own page.
  const wordCount = await install(jwt, seeded.projectId, { source: built, manifest: BUILT_MANIFEST, origin: "builder", grant: ["read:cells"] })
  await page.goto(`/project/${seeded.projectId}/extensions`)
  await expect(page.getByTestId("installed-tool").filter({ hasText: "Word Count" })).toBeVisible({ timeout: 20_000 })
  await shot(page, "06-installed-list", true)
  await page.goto(`/project/${seeded.projectId}/extensions/${wordCount}`)
  await expect(page.frameLocator('iframe[title="Word Count (sandboxed extension)"]').locator("body")).toContainText(/\d/, { timeout: 30_000 })
  await page.waitForTimeout(800)
  await shot(page, "07-detail-page")

  // 7. A runtime error → "Heal it".
  const broken = await install(jwt, seeded.projectId, { source: BROKEN, manifest: { name: "Verse Cards", description: "Each verse as a card.", scopes: ["read:cells"], mounts: ["page"], apiRev: 5 }, origin: "builder", grant: ["read:cells"] })
  await page.goto(`/project/${seeded.projectId}/extensions/${broken}`)
  await expect(page.getByRole("button", { name: /fix it with ai/i }).first()).toBeVisible({ timeout: 30_000 })
  await shot(page, "08-heal-it")

  // 8. The permission prompt (first write).
  const filler = await install(jwt, seeded.projectId, { source: FILLER, manifest: { name: "Verse Filler", description: "Fills the first verse.", scopes: ["read:cells", "write:target"], mounts: ["page"], apiRev: 5 }, origin: "builder", grant: ["read:cells"] })
  await page.goto(`/project/${seeded.projectId}/extensions/${filler}`)
  const fillerFrame = page.frameLocator('iframe[title="Verse Filler (sandboxed extension)"]')
  await fillerFrame.getByRole("button", { name: "Fill the first verse" }).click()
  await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 20_000 })
  await shot(page, "09-permission-prompt")
  await page.getByRole("alertdialog").getByRole("button").first().click()

  // 8b. The extension page's tabs: what it can do, changes & undo (+ versions).
  await page.goto(`/project/${seeded.projectId}/extensions/${wordCount}`)
  await page.getByRole("tab", { name: "Permissions" }).click()
  await page.waitForTimeout(500)
  await shot(page, "14-detail-permissions-tab")
  await page.getByRole("tab", { name: "Changes" }).click()
  await expect(page.getByTestId("tool-version").first()).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(500)
  await shot(page, "15-detail-changes-tab")
  await page.getByRole("tab", { name: "Use" }).click()
  await page.getByRole("button", { name: "Change with AI" }).click()
  await page.waitForTimeout(400)
  await shot(page, "16-detail-change-with-ai")

  // 9. The "…" menu dialogs: permissions, activity, share (copy).
  await page.goto(`/project/${seeded.projectId}/extensions`)
  const row = page.getByTestId("installed-tool").filter({ hasText: "Word Count" })
  await expect(row).toBeVisible({ timeout: 20_000 })
  const openMenu = async (item: RegExp) => {
    await row.getByTestId("tool-menu").click()
    await page.getByRole("menuitem", { name: item }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.waitForTimeout(700)
  }
  const closeDialog = async () => {
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.waitForTimeout(400)
  }
  await openMenu(/permission/i)
  await shot(page, "10-permissions-dialog")
  await closeDialog()
  await openMenu(/^changes$/i)
  await shot(page, "11-activity-revert")
  await closeDialog()
  await openMenu(/copy|share/i)
  await shot(page, "12-share-dialog")
  await closeDialog()

  // 10. Where it shows up in the editor ("Edit with" and the palette).
  await page.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  await expect(page.getByRole("combobox", { name: "Edit with" })).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  await shot(page, "13-editor-entry")
  await page.keyboard.press("ControlOrMeta+Shift+E")
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.waitForTimeout(600)
  await shot(page, "17-editor-palette")
})
