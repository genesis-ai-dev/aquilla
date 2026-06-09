import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ProgressDot — clicking a section dot navigates into the editor.
 *
 * sample.md has two sections: "## Section One" and "## Section Two".
 * FileSectionGrid renders one ProgressDot per section below the file
 * row when the row is expanded (or when there are ≥2 sections).
 *
 * Each ProgressDot button:
 *   - aria-label="${sectionLabel}: ${progressTitle}"
 *   - title="${sectionLabel}\n${progressTitle}"
 *   - onClick → navigates to that section (opens the file in the editor).
 *
 * This spec:
 *   1. Imports sample.md (has sections "Section One", "Section Two").
 *   2. Expands the file row in the sidebar (if collapsed).
 *   3. Clicks the first dot (aria-label starts with "Section").
 *   4. Verifies the editor is open (contenteditable visible).
 *   5. Verifies the URL now contains the file path (file is loaded).
 */
test("clicking a sidebar section progress dot opens the editor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ProgDot ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  const sidebar = alice.locator("aside")

  // Wait for the file row to appear.
  await expect(sidebar.getByText("sample").first()).toBeVisible({ timeout: 10_000 })

  // Expand the file row — click the chevron expand button on the row.
  const fileRowLi = sidebar.locator("li").filter({ has: sidebar.getByText("sample") }).first()
  const chevron = fileRowLi.locator("button").first()
  if (await chevron.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await chevron.click()
    await alice.waitForTimeout(300)
  }

  // ProgressDots have aria-label containing ": " (pattern "<section>: <status>").
  // sample.md sections are "Section One" and "Section Two".
  const sectionDot = sidebar.locator('button[aria-label^="Section"]').first()
  await expect(sectionDot).toBeVisible({ timeout: 5_000 })

  // The dot's aria-label tells us which section it navigates to.
  const dotLabel = await sectionDot.getAttribute("aria-label") ?? ""
  expect(dotLabel).toContain("Section")

  // Click the dot.
  await sectionDot.click()
  await alice.waitForTimeout(500)

  // After navigation the editor should be open.
  await expect(alice.locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 8_000 })

  // URL should now reference the file (contains /file/ segment).
  await expect(alice).toHaveURL(/\/file\//, { timeout: 5_000 })
})
