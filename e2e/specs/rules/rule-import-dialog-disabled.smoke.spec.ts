import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RuleImportDialog — "Import from doc" button is disabled when LLM is not configured.
 *
 * RuleImportDialog.tsx renders a "Import from doc" button (DialogTrigger) that:
 *   - Is disabled when isConfigured = false (no provider endpoint + API key)
 *   - Has title="Configure LLM in settings first" when disabled
 *
 * In a fresh project without LLM config the button is always disabled.
 *
 * This spec: navigate to /project/:id/rules → verify "Import from doc" button
 * is disabled with the configuration-required title.
 */
test("rule import button is disabled when LLM is not configured", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RuleImport ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1] ?? ""

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // "Import from doc" button is disabled because LLM is not configured.
  const importBtn = alice.getByRole("button", { name: /Import from doc/i })
  await expect(importBtn).toBeVisible({ timeout: 10_000 })
  await expect(importBtn).toBeDisabled({ timeout: 3_000 })

  // The tooltip title says "Configure LLM in settings first".
  await expect(importBtn).toHaveAttribute("title", /Configure LLM/i)
})
