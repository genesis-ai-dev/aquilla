import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * LivingMemoryPage — ValidatedCellCard with Source text and Translation labels.
 *
 * LivingMemoryPage.tsx renders ValidatedCellCard for each validated cell in
 * the "Recent Examples" section. Each card has:
 *   aria-label="Source text"   — the source text paragraph
 *   aria-label="Translation"   — the translated text paragraph
 *
 * useLivingMemory filters for cells with status === "validated" across all
 * project files and serves them as Recent Examples.
 *
 * This spec: imports a file, validates a cell, navigates to /memory,
 * and verifies the ValidatedCellCard's Source text and Translation labels
 * are visible in the Recent Examples section.
 */
test("living memory Recent Examples shows ValidatedCellCard with Source and Translation labels", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `LMCard ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Import a file.
  await alice.goto(`/project/${projectId}/editor`)
  await alice.waitForLoadState("networkidle")
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Edit and validate cell 0 so it appears in Recent Examples.
  await ws.editCell(0, "traduction validée")
  await ws.validateCell(0)

  // Navigate to the Living Memory page.
  await alice.goto(`/project/${projectId}/memory`)
  await alice.waitForLoadState("networkidle")

  // "Recent Examples" section should render.
  const recentSection = alice.locator('section[aria-label="Recent Examples"]')
  await expect(recentSection).toBeVisible({ timeout: 10_000 })

  // ValidatedCellCard has aria-label="Source text" and aria-label="Translation".
  const sourceText = recentSection.locator('[aria-label="Source text"]').first()
  await expect(sourceText).toBeVisible({ timeout: 10_000 })

  const translationText = recentSection.locator('[aria-label="Translation"]').first()
  await expect(translationText).toBeVisible({ timeout: 5_000 })
  // The translation label should show the text we entered.
  await expect(translationText).toContainText("traduction validée")
})
