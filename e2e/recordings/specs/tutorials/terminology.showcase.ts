import { expect, type Page } from "@playwright/test"
import { Workspace } from "../../../helpers/page-objects/Workspace"
import { tutorial } from "../../tutorials/tutorial"

/** Where a word sits on screen, inside the first element matching `selector`. */
async function wordBox(page: Page, selector: string, word: string) {
  const box = await page.evaluate(([selector, word]) => {
    const root = document.querySelector(selector)
    if (!root) return null
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(word) ?? -1
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + word.length)
      const r = range.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    return null
  }, [selector, word] as const)
  if (!box) throw new Error(`terminology: "${word}" not on screen`)
  return box
}

tutorial("terminology", async (t) => {
  const { page, show } = t
  const ws = new Workspace(page)

  await t.say("intro")

  // Select "Word" in verse 1's source, as a reader would: a drag across it.
  const w = await wordBox(page, '[data-showcase="editor.source"]', "Word")
  const y = w.y + w.height / 2
  await show.point({ x: w.x + 1, y })
  await page.mouse.move(w.x + 1, y)
  await page.mouse.down()
  await page.mouse.move(w.x + w.width - 1, y, { steps: 10 })
  await page.mouse.up()
  const addTo = page.getByRole("button", { name: "Add to terminology" }).first()
  await expect(addTo).toBeVisible()
  await show.point(addTo)
  await t.say("select")
  await show.click(addTo)

  const rendering = page.getByRole("textbox", { name: "Rendering for new concept" })
  await expect(rendering).toBeVisible()
  await show.click(rendering)
  const typing = rendering.pressSequentially("Parole", { delay: 60 })
  await t.say("render")
  await typing
  await show.click(page.getByRole("button", { name: "Add term" }).last())

  const term = page.locator('[data-showcase="editor.source"]').getByRole("button", { name: "Word" }).first()
  await expect(term).toBeVisible({ timeout: 10_000 })
  await t.closeUp(term, async () => {
    await show.point(term)
    await t.say("marked")
  }, 1.5)

  // A translation of verse 1 that uses another word for it.
  await ws.activateTargetCell(0)
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("Au commencement était le Verbe, et le Verbe était avec Dieu, et le Verbe était Dieu.", { delay: 12 })
  await ws.blurEditor()
  await expect(page.locator('[data-cell-type="target"]').first()).toContainText("le Verbe")
  await page.waitForTimeout(1500)
  await t.closeUp(term, async () => {
    await show.point(term)
    await t.say("missed")
  }, 1.5)

  const page2 = page.getByText("Terminology", { exact: true }).first()
  await show.click(page2)
  await expect(page.getByText("Parole").first()).toBeVisible()
  await t.say("page")
})
