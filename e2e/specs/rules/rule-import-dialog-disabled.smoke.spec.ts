import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * RuleImportDialog — "Import from doc" button is disabled when LLM is not configured.
 *
 * RuleImportDialog.tsx renders a "Import from doc" button (DialogTrigger) that:
 *   - Is disabled when isConfigured = false
 *   - Has tooltip "Configure LLM in settings first" when disabled
 *
 * For the default "frontier" provider, isConfigured = session.jwt AND the
 * /api/v2/health probe succeeding (frontier-health.ts). In the e2e stack the
 * local identity worker answers that probe, so a fresh project IS configured.
 * To exercise the not-configured gate we block the health endpoint, making
 * the frontier provider unavailable.
 *
 * This spec: block /api/v2/health → navigate to /project/:id/rules → verify
 * "Import from doc" button is disabled with the configuration-required tooltip.
 */
test("rule import button is disabled when LLM is not configured", async ({ alice }) => {
  // Make the frontier LLM provider unavailable (health probe fails).
  await alice.route("**/api/v2/health*", (route) => route.abort())

  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `RuleImport ${Date.now()}` })
  await alice.goto(`/project/${seeded.projectId}/rules`)
  // "Import from doc" button is disabled because LLM is not configured.
  const importBtn = alice.getByRole("button", { name: /Import from doc/i })
  await expect(importBtn).toBeVisible({ timeout: 10_000 })
  await expect(importBtn).toBeDisabled({ timeout: 3_000 })

  await expect(importBtn).toHaveAttribute("title", /Configure LLM in settings first/, { timeout: 3_000 })
})
