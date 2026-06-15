import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Verify built-in rule enable + violation surfacing.
 *
 * The "double-space" check has display name "Extra whitespace" (per
 * src/lib/lqa/builtin-registry.ts). The rules page uses an `aria-label`
 * of `${def.name} enabled` for each toggle. A cell with violations
 * tints the cell number pill amber/red as the single issue surface.
 */
// Fixed: use keyboard.insertText() instead of keyboard.type() for the
// double-space cell text — insertText dispatches a single input event
// rather than individual keydown/keypress/keyup events, so ProseMirror
// does not normalize consecutive spaces away.
test("alice enables 'Extra whitespace' rule and sees a violation surfaced in editor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Rules ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // Enable the built-in rule on the rules page (shadcn Switch, role="switch").
  await alice.goto(`/project/${projectId}/rules`)
  const toggle = alice.getByRole("switch", { name: /Extra whitespace enabled/i })
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 3_000 })
  }

  // Back to workspace, import, type a violation.
  await alice.goto(`/project/${projectId}`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  // Use insertText (not keyboard.type) to preserve consecutive spaces through
  // ProseMirror — type() fires individual key events that get normalized.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  const editable = row.locator('textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"]').first()
  await editable.waitFor({ state: "visible", timeout: 10_000 })
  await editable.click()
  await alice.keyboard.insertText("this  has  double  spaces") // intentional doubles
  await alice.locator("aside").click() // blur
  await alice.waitForTimeout(2_000)

  // The cell number is the issue surface and tints amber for minor infractions.
  const linePill = ws.cellRow(0).locator('[aria-label="Line 1"] span').first()
  await expect(linePill).toHaveClass(/text-amber-600/, { timeout: 10_000 })
})
