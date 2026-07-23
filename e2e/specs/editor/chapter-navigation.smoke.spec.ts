import { expect, test } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_USFM = path.resolve(__dirname, "../../fixtures/sample.usfm")

test("scripture editor shows canonical verse numbers and supports chapter navigation", async ({ alice }) => {
  const dashboard = new Dashboard(alice)
  await dashboard.goto()
  const projectName = `Chapter nav ${Date.now()}`
  await dashboard.createProject({ name: projectName, source: "en", target: "fr" })
  await dashboard.openProject(projectName)

  const workspace = new Workspace(alice)
  await workspace.importFile(SAMPLE_USFM)
  await workspace.waitForEditor()
  // Keep the two-chapter fixture taller than the editor viewport so viewport-
  // based chapter tracking cannot immediately snap back to chapter 1.
  await alice.setViewportSize({ width: 1280, height: 500 })

  const chapterMenuTrigger = alice.getByRole("button", { name: /Current chapter:/ })
  const chapterTrigger = alice.getByRole("button", { name: /Current chapter: Genesis 1/ })
  await expect(chapterTrigger).toContainText("Verses 1–2")

  const chapterOneVerse = alice.locator("[data-cell-id]").filter({
    hasText: "In the beginning God created the heavens and the earth.",
  })
  await expect(chapterOneVerse.getByLabel("Line 1")).toBeVisible()

  const chapterHeading = alice.locator("[data-cell-id]").filter({ hasText: "Genesis" }).first()
  await expect(chapterHeading.getByLabel("Line 1")).toHaveCount(0)

  await alice.getByRole("button", { name: "Next chapter" }).click()

  const chapterTwoVerse = alice.locator("[data-cell-id]").filter({
    hasText: "Thus the heavens and the earth were finished.",
  })
  await expect(chapterTwoVerse).toBeVisible()
  await expect(chapterTwoVerse.getByLabel("Line 1")).toBeVisible()
  // Assert after the animated list jump has settled. The selected chapter
  // must not be overwritten by viewport tracking when the final chapter is
  // too short to align its first verse with the top edge.
  await expect(alice.getByRole("button", { name: /Current chapter: Genesis 2/ })).toContainText("Verses 1–2")

  await chapterMenuTrigger.click()
  await alice.getByRole("option", { name: /Genesis 1/ }).click()
  await expect(alice.getByRole("button", { name: /Current chapter: Genesis 1/ })).toBeVisible()

  await chapterMenuTrigger.click()
  const chapterSearch = alice.getByRole("combobox", { name: "Find a chapter" })
  await chapterSearch.fill("21")
  await expect(alice.getByText("No chapters found.")).toBeVisible()
  await chapterSearch.fill("2")
  await expect(alice.getByRole("option", { name: /Genesis 2/ })).toBeVisible()
  await expect(alice.getByRole("option", { name: /Genesis 1/ })).toHaveCount(0)
})
