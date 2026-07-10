import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { pickSelectOption } from "../../helpers/base-ui"
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
 * sample.md includes the word "content" in plain-paragraph cell text. We add
 * a terminology concept for "content" in the project, then open the editor
 * and verify:
 *   1. The word "content" in the source column has a dotted-underline span.
 *   2. Clicking it opens the popover.
 *   3. The popover is visible with the term name.
 *
 * NOTE: the concept word must come from an UNFORMATTED cell. Cells with
 * inline formatting carry `originalHtml` and render via sanitized HTML
 * (EditorTable.tsx), which bypasses SourceWithTermLookup entirely — so the
 * bolded "sample" cell never gets the underline affordance.
 */
test("term lookup popover appears for terminology-matched source word", async ({ alice }) => {
  // Project create + terminology round-trip + a full AQU-310 import flow can
  // exceed the 30s harness budget under load.
  test.slow()
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

  await dialog.locator("#concept-source-term").fill("content")
  await dialog.locator('input[placeholder="rendering"]').first().fill("échantillon")
  // New concepts default to "suggested" (draft); the editor only decorates
  // source tokens for ACTIVE concepts (SourceWithTermLookup filters on
  // status === "active"), so mark it "approved" before saving.
  await pickSelectOption(alice, dialog.locator("#concept-status"), "approved")
  await dialog.getByRole("button", { name: /^Add concept$/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Open the workspace and import the file.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Find the dotted-underline span for "content" in the source column.
  // TermLookupPopover wraps the word in a span with cursor-pointer + underline.
  const termSpan = alice
    .locator("span.cursor-pointer.underline")
    .filter({ hasText: /^content$/i })
    .first()
  await expect(termSpan).toBeVisible({ timeout: 10_000 })

  // Click to open the popover.
  await termSpan.click()

  // Popover with aria-label "Terminology lookup for "content"" opens.
  const popover = alice.locator('[aria-label*="Terminology lookup"]')
  await expect(popover).toBeVisible({ timeout: 5_000 })
})
