import { expect, type Page } from "@playwright/test"
import { Workspace } from "../../../helpers/page-objects/Workspace"
import { tutorial } from "../../tutorials/tutorial"

/** The demo organization's second project: a Kreyòl team that translates the French draft. */
const CHAIN_PROJECT = "demo-jean-kreyol"
const UPSTREAM_PROJECT = "demo-john"

/** Open a project's editor from its overview page. */
async function openProject(page: Page, id: string): Promise<void> {
  await page.goto(`/project/${id}`)
  await page.getByRole("button", { name: "Open project" }).click()
}

/** The book-name suggestion is not what this video is about. */
async function dismissRename(page: Page): Promise<void> {
  const rename = page.getByText(/apply friendly names\?/)
  if (await rename.waitFor({ state: "visible", timeout: 4_000 }).then(() => true, () => false)) {
    await page.getByRole("button", { name: "Dismiss" }).filter({ visible: true }).first().click()
    await rename.waitFor({ state: "hidden" })
  }
}

tutorial("link-a-source", async (t) => {
  const { page, show } = t
  const ws = new Workspace(page)

  await t.say("intro")
  await show.point(page.getByText("Jean — Kreyòl Draft").first())
  await t.say("when")

  const importButton = page.getByRole("button", { name: /^Import$/ }).first()
  await show.click(importButton)
  const fromProject = page.getByRole("button", { name: /^From another project/ })
  await expect(fromProject).toBeVisible()
  await show.point(fromProject)
  await t.say("open")
  await show.click(fromProject)

  const picker = page.getByRole("combobox", { name: "Source project" })
  await show.click(picker)
  await show.click(page.getByRole("option", { name: /Plainspeak/ }).first())
  const targets = page.getByText("One of its targets").first()
  await show.click(targets)
  await t.closeUp(page.getByText("Which of its translations?"), async () => {
    await show.point(page.getByText("Which of its translations?"))
    await t.say("choose")
  }, 1.3)

  await show.click(page.getByRole("button", { name: /^Review what will be added/ }))
  const confirm = page.getByText(/^Link to John — Plainspeak Draft\?/)
  await expect(confirm).toBeVisible()
  await show.point(confirm)
  await t.say("review")
  await show.click(page.getByRole("button", { name: "Link source project" }))

  // The French arrives as this project's source.
  const firstSource = page.getByText(/^Au commencement était la Parole/).first()
  await expect(firstSource).toBeVisible({ timeout: 30_000 })
  await dismissRename(page)
  await show.point(firstSource)
  await ws.activateTargetCell(1)
  const typing = page.keyboard.type("Li te la nan kòmansman an avèk Bondye.", { delay: 40 })
  await t.say("linked")
  await typing
  await ws.blurEditor()

  // Meanwhile the French team revises verse 2 in the source project: in a
  // second page, off camera. The Kreyòl project stays open and follows the
  // link live, as a translator would see it.
  const revised = page.getByText("Elle était au commencement auprès de Dieu.").first()
  const upstream = await page.context().newPage()
  const revise = (async () => {
    const upstreamWs = new Workspace(upstream)
    await openProject(upstream, UPSTREAM_PROJECT)
    await upstream.locator('[data-showcase="editor.source"]').first().waitFor()
    await upstream.waitForTimeout(1000)
    await upstreamWs.activateTargetCell(1)
    await upstream.keyboard.press("ControlOrMeta+a")
    await upstream.keyboard.type("Elle était au commencement auprès de Dieu.")
    await upstreamWs.blurEditor()
  })()
  await show.point(page.getByText(/^Elle était au commencement/).first())
  await t.say("upstream")
  await revise
  await upstream.close()
  // The marker comes as soon as the source project saves; the new French
  // follows a moment later, while the line is being said.
  const marker = page.getByRole("button", { name: "Source changed since last revision" }).first()
  await expect(marker).toBeVisible({ timeout: 30_000 })
  await t.closeUp(marker, async () => {
    await show.point(marker)
    await t.say("stale")
  }, 1.6)
  await expect(revised).toBeVisible({ timeout: 30_000 })
}, {
  setup: async (page) => {
    await openProject(page, CHAIN_PROJECT)
    await expect(page.getByText("No files yet")).toBeVisible({ timeout: 20_000 })
  },
})
