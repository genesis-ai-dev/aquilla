import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

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
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AiSetup ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

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
