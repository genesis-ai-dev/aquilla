import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RuleSuggestDialog — "Suggest from edits" button is disabled when LLM is not configured.
 *
 * RulesPage.tsx renders a RuleSuggestDialog with a "Suggest from edits" button
 * (DialogTrigger). When LLM is not configured:
 *   - The button is disabled
 *   - Its title attribute is "Configure LLM in settings first"
 *
 * This spec: navigate to /project/:id/rules → verify "Suggest from edits"
 * button is visible, disabled, and has the correct title tooltip.
 */
test("rule suggest button is disabled when LLM is not configured", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RuleSuggest ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1] ?? ""

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // "Suggest from edits" button is disabled when LLM is not configured.
  const suggestBtn = alice.getByRole("button", { name: /Suggest from edits/i })
  await expect(suggestBtn).toBeVisible({ timeout: 10_000 })
  await expect(suggestBtn).toBeDisabled({ timeout: 3_000 })

  // The tooltip title says "Configure LLM in settings first".
  await expect(suggestBtn).toHaveAttribute("title", /Configure LLM/i)
})
