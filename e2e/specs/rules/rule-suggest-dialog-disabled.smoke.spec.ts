import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RuleSuggestDialog — "Suggest from edits" button is disabled when LLM is not configured.
 *
 * The workspace header renders RuleSuggestFromEditsDialog's "Suggest from
 * edits" button when the rules surface is open. When LLM is not configured:
 *   - The button is disabled
 *   - Its tooltip is "Configure LLM in settings first"
 *
 * For the default "frontier" provider, isConfigured = session.jwt AND the
 * /api/v2/health probe succeeding. The e2e identity worker answers that
 * probe, so we block the health endpoint to exercise the gate.
 *
 * This spec: block /api/v2/health → navigate to /project/:id/rules → verify
 * "Suggest from edits" button is visible, disabled, and has the app tooltip.
 */
test("rule suggest button is disabled when LLM is not configured", async ({ alice }) => {
  // Make the frontier LLM provider unavailable (health probe fails).
  await alice.route("**/api/v2/health*", (route) => route.abort())

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RuleSuggest ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1] ?? ""

  await alice.goto(`/project/${projectId}/rules`)
  // "Suggest from edits" button is disabled when LLM is not configured.
  const suggestBtn = alice.getByRole("button", { name: /Suggest from edits/i })
  await expect(suggestBtn).toBeVisible({ timeout: 10_000 })
  await expect(suggestBtn).toBeDisabled({ timeout: 3_000 })

  await expect(suggestBtn).toHaveAttribute("title", /Configure LLM in .*settings first/, { timeout: 3_000 })
})
