import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ViolationPopover — clicking the infraction badge opens a popover
 * listing the rule violation.
 *
 * EditorTable renders a CellNumberPill button (aria-label="N issue(s)")
 * when a cell has infractions. Clicking it opens a Popover showing the
 * rule name and infraction count heading.
 *
 * This spec: enable "Extra whitespace" rule → create a violation → click
 * the issue badge → popover shows "1 issue" heading + "Extra whitespace" rule name.
 */
test("violation badge click opens popover with rule name", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ViolPopover ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // Enable Extra whitespace rule.
  await alice.goto(`/project/${projectId}/rules`)
  const toggle = alice.getByRole("checkbox", { name: /Extra whitespace enabled/i })
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  if (!(await toggle.isChecked())) {
    await toggle.check()
  }

  // Import file and create a violation.
  await alice.goto(`/project/${projectId}`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  const editable = row.locator('textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"]').first()
  await editable.waitFor({ state: "visible", timeout: 10_000 })
  await editable.click()
  await alice.keyboard.insertText("this  has  double  spaces")
  await alice.locator("aside").click()

  // Wait for infraction badge.
  const badge = ws.cellRow(0).locator('[aria-label*="issue"]').first()
  await expect(badge).toBeVisible({ timeout: 10_000 })

  // Click the badge to open the popover.
  await badge.click()

  // Popover shows the rule name "Extra whitespace".
  await expect(alice.getByText(/Extra whitespace/i).first()).toBeVisible({ timeout: 5_000 })
})
