import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Terminology — Candidate terms tab.
 *
 * TerminologyPage has three tabs: "Concepts", "Candidate terms", "Violations".
 * The Candidates tab is populated by off-thread mining (extractCandidates)
 * once a project has files. Mining runs when the tab is selected.
 *
 * This spec:
 *   1. Imports a file (populates the corpus).
 *   2. Navigates to /terminology.
 *   3. Clicks the "Candidate terms" tab button.
 *   4. Verifies CandidateTermsPanel renders — either a loading indicator
 *      or the candidate list (or an empty-state message when no candidates).
 */
test("terminology candidate terms tab renders when selected", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermCand ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Import a file so there's a corpus for mining.
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

  // The tab becomes active. The panel renders — either loading or content.
  // Mining is fast (in-process WASM/sync). We allow up to 10s for it to finish.
  // A non-error state means either rows or an empty-state message.
  // Mining starts immediately; panel shows "Mining candidate terms…" or the result.
  await expect(
    alice.getByText(/Mining candidate terms/i).first()
      .or(alice.getByText(/No candidate terms found/i).first())
      .or(alice.getByText(/candidate term.*ranked/i).first())
  ).toBeVisible({ timeout: 10_000 })
})
