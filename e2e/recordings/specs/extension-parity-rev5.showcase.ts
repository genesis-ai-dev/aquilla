import { test, expect, type Page } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { resetBackend } from "../../helpers/seed"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { createProjectLane, readProjectLanes } from "../../helpers/frontier-api"
import { applyUserProviderOverride } from "../../helpers/mock-llm-server"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ToolsPage, DEFAULT_EDITOR } from "../../helpers/page-objects/ToolsPage"
import { Workspace } from "../../helpers/page-objects/Workspace"

/**
 * Smart Extensions apiRev 5 parity, back to back: the Aquilla NATIVE editor
 * (the default) and the first-party extension editor (opted into from
 * "Edit with") on the features dev's built-in editor gained after the
 * apiRev 4 claim. 1280×720, two takes:
 *   1. integrity explanations on hover (AQU-757) + the validated-vs-guessed
 *      provenance wash on an AI draft (#946);
 *   2. Align styles on an IDML multi-run cell + the archived-lane banner
 *      (AQU-1463).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const AUTH_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
const FRAME = { width: 1280, height: 720 }

test.use({ viewport: FRAME, video: { mode: "on", size: FRAME } })

/** A caption pill that survives navigation (re-injected when missing). */
async function say(page: Page, text: string, holdMs = 1600): Promise<void> {
  await page.evaluate((tx) => {
    let el = document.getElementById("__rev5_caption")
    if (!el) {
      el = document.createElement("div")
      el.id = "__rev5_caption"
      el.setAttribute("style", "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;"
        + "max-width:86%;text-align:center;background:rgba(12,16,24,.86);color:#fff;padding:9px 20px;border-radius:999px;"
        + "font:600 17px Inter,system-ui,sans-serif")
      document.body.appendChild(el)
    }
    el.textContent = tx
  }, text)
  await page.waitForTimeout(holdMs)
}

async function signIn(page: Page): Promise<void> {
  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173" }])
  await page.addInitScript(() => { try { localStorage.setItem("aq.health-score-color-coding.v1", "on") } catch { /* private mode */ } })
  await page.goto("/")
  await injectSession(page, session)
}

test("Smart Extensions rev 5 parity — hover explanations and the provenance wash", async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page)
  await applyUserProviderOverride(page, "alice", `${process.env.VITE_LLM_BASE_URL ?? ""}/v1`)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: "Matthew (Spanish)", fixturePath: FIXTURE })
  const ws = new Workspace(page, "builtin")
  const tools = new ToolsPage(page)
  await page.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  await ws.waitForEditor()
  // AI-draft the heading so there is a draft to wash (mock LLM).
  await ws.openAiSetupFromFirstCell()
  await ws.confirmAiSetup()
  await ws.clickSparkleOnFirstCell()
  await expect(ws.cellRow(0).locator("[data-health-span]").first()).toBeVisible({ timeout: 20_000 })
  await page.mouse.move(640, 690)

  await say(page, "Native editor (the default) — hover a tinted verse number", 1400)
  await ws.cellRow(1).locator("[data-testid=cell-issue-flag]").hover()
  await expect(page.getByRole("tooltip").first()).toContainText("Empty translation")
  await page.waitForTimeout(1600)
  await say(page, "Native: AI draft washed — green = in a validated example, orange = guessed", 2200)

  await tools.switchEditor(DEFAULT_EDITOR)
  const frame = tools.toolFrame(DEFAULT_EDITOR)
  await expect(tools.translationBox(frame, "MAT 1:1")).toBeVisible({ timeout: 30_000 })
  await page.mouse.move(640, 690)
  await say(page, "Smart Extension editor (opted in from \"Edit with\") — same hover", 1400)
  await frame.locator('.cell[data-ref="MAT 1:1"] [data-testid=cell-issue-flag]').hover()
  await expect(frame.locator(".tip")).toContainText("Empty translation")
  await page.waitForTimeout(1600)
  await say(page, "Extension: the same provenance wash on the same draft", 2200)
})

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'

async function writeIdml(filePath: string): Promise<void> {
  const zip = new JSZip()
  zip.file("mimetype", IDML_MIME, { compression: "STORE", createFolders: false })
  zip.file("designmap.xml", `<?xml version="1.0" encoding="UTF-8"?><Document ${IDPKG}><idPkg:Story src="Stories/Story_u100.xml"/></Document>`)
  zip.file("Resources/Styles.xml", `<?xml version="1.0"?><idPkg:Styles ${IDPKG}></idPkg:Styles>`)
  zip.file("Stories/Story_u100.xml", [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<idPkg:Story ${IDPKG}><Story Self="u100">`,
    '<ParagraphStyleRange Self="h" AppliedParagraphStyle="ParagraphStyle/Heading"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>Psalm 23</Content></CharacterStyleRange></ParagraphStyleRange>',
    '<ParagraphStyleRange Self="m" AppliedParagraphStyle="ParagraphStyle/Body">',
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>The </Content></CharacterStyleRange>',
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold"><Content>LORD</Content></CharacterStyleRange>',
    '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content> is my shepherd; I shall not want. He makes me lie down in green pastures. He leads me beside still waters. He restores my soul. He leads me in paths of righteousness for his name’s sake.</Content></CharacterStyleRange>',
    "</ParagraphStyleRange>",
    "</Story></idPkg:Story>",
  ].join(""))
  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }))
}

test("Smart Extensions rev 5 parity — Align styles and the archived-lane banner", async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  await signIn(page)
  await applyUserProviderOverride(page, "alice", `${process.env.VITE_LLM_BASE_URL ?? ""}/v1`)
  const fixture = testInfo.outputPath("psalm-23.idml")
  await writeIdml(fixture)
  const dash = new Dashboard(page)
  await dash.goto()
  await dash.createProject({ name: "Psalms (Français)", source: "en", target: "fr" })
  await dash.openProject("Psalms (Français)")
  const ws = new Workspace(page, "builtin")
  const tools = new ToolsPage(page)
  await ws.importFile(fixture)
  await ws.openFileBySubstring("psalm-23")
  await ws.waitForEditor()
  const [, projectId] = /\/project\/([^/]+)/.exec(page.url()) ?? []
  const jwt = await jwtFor("alice")
  const lane = (await readProjectLanes(jwt, projectId)).find((l) => l.role === "target" && !l.archivedAt)
  const frame = tools.toolFrame(DEFAULT_EDITOR)
  const row = frame.locator(".cell").nth(1)
  const NEEDS_TEXT = "Translate this cell before aligning styles"
  await ws.openAiSetupFromFirstCell()
  await ws.confirmAiSetup()
  await page.mouse.move(640, 690)

  await say(page, "Native editor: an InDesign cell with bold and plain runs gets Align styles", 1400)
  const align = await ws.openRowAction(ws.cellRow(1), NEEDS_TEXT)
  await align.hover({ force: true })
  await page.waitForTimeout(1800)
  await page.keyboard.press("Escape")

  await tools.switchEditor(DEFAULT_EDITOR)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await say(page, "Smart Extension editor: the same action, same place, same gate", 1200)
  await row.hover()
  await row.locator("[data-slot=cell-action-rail-overflow]").click()
  const extAlign = frame.locator(`.overflow button[aria-label='${NEEDS_TEXT}']`)
  await expect(extAlign).toBeVisible()
  await expect(extAlign).toBeDisabled()
  await page.waitForTimeout(1600)
  await page.keyboard.press("Escape")

  // A project lead archives the lane this editor is pointed at (a second lane keeps the project writable).
  const active = lane
  await createProjectLane(jwt, projectId, { name: "Créole", language: "Haitian Creole" })
  const archived = await fetch(`${AUTH_BASE}/api/v2/projects/${projectId}/lanes/${active?.id}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ archived: true }),
  })
  expect(archived.ok).toBe(true)
  const dialog = page.getByRole("dialog").filter({ hasText: /archived/i }).first()
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await say(page, "The lane is archived live — the member is told, then the lane locks", 1800)
  await dialog.getByRole("button").first().click()
  await expect(frame.locator("[data-testid=lane-archived-banner]")).toBeVisible()
  await say(page, "Extension editor: the built-in's own archived-lane banner", 2000)
  await tools.switchEditor("Standard editor")
  await expect(page.getByTestId("lane-archived-banner")).toBeVisible()
  await say(page, "Native editor: the same banner, word for word", 2200)
})
