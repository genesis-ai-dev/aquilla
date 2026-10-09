import { test, expect } from "@playwright/test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { resetBackend } from "../../helpers/seed"
import { addProjectMember, ROLE } from "../../helpers/frontier-api"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { DEFAULT_EDITOR, ToolsPage } from "../../helpers/page-objects/ToolsPage"

/**
 * Smart Extensions — the DEFAULT editor is an extension, 1280×720.
 * Opening a file shows the first-party "Aquilla Editor" extension (sandboxed,
 * auto-granted and saying so). Alice translates with rich text and validates;
 * Bob (a second browser, off camera) takes a verse — his focus lock and then
 * his text appear live; the built-in editor is one switch away, and back.
 * Writes `<outputDir>/timeline.json` (ms offsets) for trimming the set-up.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173"
const FRAME = { width: 1280, height: 720 }

test.use({ viewport: FRAME, video: { mode: "on", size: FRAME } })

test("Smart Extensions — the default editor is an extension", async ({ page, browser }, testInfo) => {
  test.setTimeout(300_000)
  const t0 = Date.now()
  await resetBackend()
  const session = await ensureAuthState("alice")
  const bobSession = await ensureAuthState("bob")
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: BASE }])
  const tools = new ToolsPage(page)
  await tools.optIntoDefaultEditorExtension()
  await page.goto("/")
  await injectSession(page, session)

  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: "Matthew (Spanish)", fixturePath: FIXTURE })
  await addProjectMember(jwt, seeded.projectId, "bob", ROLE.CONTRIBUTOR)

  // Bob: his own browser, not recorded.
  const bobCtx = await browser.newContext({ viewport: FRAME, recordVideo: undefined })
  await bobCtx.addCookies([{ name: "aq_hint", value: "1", url: BASE }])
  const bob = await bobCtx.newPage()
  const bobTools = new ToolsPage(bob)
  await bobTools.optIntoDefaultEditorExtension()
  await bob.goto(`${BASE}/`)
  await injectSession(bob, bobSession)

  const frame = await tools.openFileInDefaultEditor(seeded.projectId, seeded.fileId, "MAT 1:1")
  await expect(page.getByTestId("first-party-notice")).toBeVisible()
  const timeline: Record<string, number> = { editorOpen: Date.now() - t0 }
  await page.waitForTimeout(2500)

  const v11 = tools.translationBox(frame, "MAT 1:1")
  await v11.click()
  await v11.pressSequentially("Libro de la genealogía de Jesucristo, hijo de David.", { delay: 28 })
  await v11.press("Tab")
  const v12 = tools.translationBox(frame, "MAT 1:2")
  await v12.pressSequentially("Abraham ", { delay: 28 })
  await v12.press("ControlOrMeta+b")
  await v12.pressSequentially("engendró", { delay: 28 })
  await v12.press("ControlOrMeta+b")
  await v12.pressSequentially(" a Isaac.", { delay: 28 })
  await v12.press("Enter")
  await page.waitForTimeout(700)
  await tools.editorRow(frame, "MAT 1:2").getByRole("button", { name: "Validate MAT 1:2" }).click()
  await expect(tools.editorRow(frame, "MAT 1:2").getByRole("button", { name: "Unvalidate MAT 1:2" })).toBeVisible()
  timeline.validated = Date.now() - t0
  await page.waitForTimeout(1200)

  // Bob takes MAT 1:3 in his browser: alice sees his lock, then his words.
  const bobFrame = await bobTools.openFileInDefaultEditor(seeded.projectId, seeded.fileId, "MAT 1:3")
  const bob13 = bobTools.translationBox(bobFrame, "MAT 1:3")
  await bob13.click()
  await expect(tools.editorRow(frame, "MAT 1:3")).toContainText("bob is editing")
  timeline.bobLock = Date.now() - t0
  await page.waitForTimeout(1800)
  await bob13.pressSequentially("José le puso por nombre Jesús.", { delay: 20 })
  await bob13.press("Enter")
  await expect(tools.translationBox(frame, "MAT 1:3")).toHaveText("José le puso por nombre Jesús.")
  timeline.remoteEdit = Date.now() - t0
  await page.waitForTimeout(2500)

  // The built-in editor is one switch away — same text — and back.
  await tools.switchEditor("Standard editor")
  await expect(page.getByText("José le puso por nombre Jesús.").first()).toBeVisible()
  await page.waitForTimeout(3000)
  await tools.switchEditor(`${DEFAULT_EDITOR} (default)`)
  await expect(tools.translationBox(tools.toolFrame(DEFAULT_EDITOR), "MAT 1:3")).toHaveText("José le puso por nombre Jesús.")
  await page.waitForTimeout(2500)
  timeline.end = Date.now() - t0
  await bobCtx.close()
  writeFileSync(testInfo.outputPath("timeline.json"), JSON.stringify(timeline, null, 2))
})
