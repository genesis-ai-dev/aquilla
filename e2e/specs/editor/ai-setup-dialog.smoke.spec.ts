import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Cell sparkle button — Frontier AI is the zero-setup default.
 *
 * Since 06b494104 ("Frontier default + collapse advanced LLM settings"),
 * a project with NO completionSettings falls back to the Frontier provider,
 * and useCompletion treats a signed-in user as configured
 * (isConfigured = Boolean(session?.jwt)). The old "Set up AI to enable"
 * rail state — which opened AiSetupDialog — is therefore unreachable for
 * signed-in users; it only appears for a custom provider missing its
 * endpoint/model.
 *
 * The CellActionRail sparkle button (EditorTable.tsx RailButton) renders the
 * state as both title= and aria-label=:
 *   "Sign in for AI translations" | "Read-only (imported from git)" |
 *   "Set up AI to enable" | "AI service unavailable — try again shortly" |
 *   "Generating…" | "Translate with AI"
 *
 * This spec verifies the new default: a signed-in user on a fresh project
 * (no completionSettings) gets a ready-to-use, ENABLED "Translate with AI"
 * sparkle — no setup dialog gate. We deliberately do NOT click it (that
 * would fire a real completion request).
 *
 * Note: rail children are opacity:0 until the row is hovered — hover first.
 */
test("cell sparkle button is ready (Translate with AI) without setup for signed-in users", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AiSetup ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Hover the first cell row to reveal the CellActionRail.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // Frontier default: the sparkle reads "Translate with AI" — NOT the old
  // "Set up AI to enable" gate — and is enabled (signed-in ⇒ configured).
  const sparkleBtn = row.locator('[aria-label="Translate with AI"]')
  await expect(sparkleBtn).toBeVisible({ timeout: 5_000 })
  await expect(sparkleBtn).toBeEnabled()

  // The unconfigured gate must not be present anywhere on the row.
  await expect(row.locator('[aria-label="Set up AI to enable"]')).toHaveCount(0)
})
