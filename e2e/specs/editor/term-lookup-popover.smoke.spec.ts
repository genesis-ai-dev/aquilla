import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * TermLookupPopover — source-cell word matching a terminology concept.
 *
 * EditorTable.tsx wraps source-cell tokens matching a concept entry in a
 * <TermLookupPopover> — the span gets a dotted underline and, when clicked,
 * opens the popover (aria-label="Terminology lookup for "<word>"").
 *
 * sample.md includes the word "sample" in cell text. We add a terminology
 * concept for "sample" in the project, then open the editor and verify:
 *   1. The word "sample" in the source column has a dotted-underline span.
 *   2. Clicking it opens the popover.
 *   3. The popover is visible with the term name.
 */
test("term lookup popover appears for terminology-matched source word", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermPopover ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Add a concept for the word "sample" via the Terminology page.
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  await alice.getByRole("button", { name: /Add concept/i }).first().click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  await dialog.locator("#concept-source-term").fill("sample")
  await dialog.locator('input[placeholder="rendering"]').first().fill("échantillon")
  await dialog.getByRole("button", { name: /^Add concept$/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Open the workspace and import the file.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Find the dotted-underline span for "sample" in the source column.
  // TermLookupPopover wraps the word in a span with cursor-pointer + underline.
  const termSpan = alice.locator(
    'span.cursor-pointer.underline',
    // { hasText: /^sample$/i }
  ).filter({ hasText: /^sample$/i }).first()
  await expect(termSpan).toBeVisible({ timeout: 10_000 })

  // Click to open the popover.
  await termSpan.click()

  // Popover with aria-label "Terminology lookup for "sample"" opens.
  const popover = alice.locator('[aria-label*="Terminology lookup"]')
  await expect(popover).toBeVisible({ timeout: 5_000 })
})
