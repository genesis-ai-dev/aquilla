import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Terminology — "Promote to managed" button in CandidateTermsPanel.
 *
 * TerminologyPage.tsx uses extractCandidates() (via a Web Worker) to mine
 * candidate terms from the loaded file corpus. sample.md has repeated words
 * ("paragraph" ×3, "section" ×2, "content" ×2) that appear as candidates
 * above the default minFreq=2 threshold.
 *
 * CandidateTermsPanel renders a list of candidates. Each row that isn't
 * already managed has a "Promote to managed" button. Clicking it calls
 * handlePromoteCandidate() which:
 *   1. Adds a Concept (sourceTerm=candidate.term, status="draft") via addConcept()
 *   2. Calls setEditTarget(created) → opens the "Edit concept" dialog
 *
 * This spec:
 *   1. Imports sample.md (populates the corpus).
 *   2. Navigates to /terminology → clicks "Candidate terms" tab.
 *   3. Waits for at least one candidate row to appear.
 *   4. Clicks the first "Promote to managed" button.
 *   5. Verifies the "Edit concept" dialog opens.
 */
test("terminology promote candidate opens Edit concept dialog", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermPromote ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Import file so there's a corpus to mine.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Navigate to terminology.
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Click "Candidate terms" tab.
  const candidatesTab = alice.getByRole("button", { name: /Candidate terms/i })
  await expect(candidatesTab).toBeVisible({ timeout: 10_000 })
  await candidatesTab.click()

  // Wait for mining to complete — at least one "Promote to managed" button must appear.
  // sample.md has "paragraph" ×3 and "section" ×2, both above minFreq=2.
  const promoteBtn = alice.getByRole("button", { name: /Promote to managed/i }).first()
  await expect(promoteBtn).toBeVisible({ timeout: 15_000 })

  // Click the first "Promote to managed".
  await promoteBtn.click()

  // handlePromoteCandidate sets editTarget → "Edit concept" dialog opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByText(/Edit concept/i)).toBeVisible({ timeout: 3_000 })
})
