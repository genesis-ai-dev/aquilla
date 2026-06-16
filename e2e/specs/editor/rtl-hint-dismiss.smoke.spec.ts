import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ViewSettingsMenu — RTL detection hint and Dismiss button.
 *
 * ViewSettingsMenu.tsx:
 *   const rtlDetected = sourceTextDirection === "rtl" || targetTextDirection === "rtl"
 *   const showHint = fileOpen && rtlDetected && !rtlHintDismissed
 *
 * When a project targets an RTL language (e.g. "ar" Arabic), detectDirection()
 * returns "rtl" for targetTextDirection, making rtlDetected = true.
 * A nudge popover appears in the toolbar with:
 *   - "Detected right-to-left for target" text
 *   - An "Adjust" button (opens the view settings menu)
 *   - A title="Dismiss" X button that hides the hint
 *
 * This spec: creates a project with target "ar" → imports a file → opens it
 * → verifies the RTL hint shows → clicks Dismiss → hint disappears.
 */
test("RTL detection hint shows for Arabic target language and can be dismissed", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RtlHint ${Date.now()}`
  // Arabic target → detectDirection("ar") returns "rtl"
  await dash.createProject({ name, source: "en", target: "ar" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The RTL hint nudge should appear automatically (role="status").
  const hint = alice.locator('[role="status"]').filter({ hasText: /right-to-left/i })
  await expect(hint).toBeVisible({ timeout: 8_000 })

  // The hint mentions "target" (since source is "en" = ltr, target is "ar" = rtl).
  await expect(hint).toContainText(/target/i)

  // The Dismiss button is visible.
  const dismissBtn = hint.getByRole("button", { name: "Dismiss" })
    .or(alice.locator('[data-tooltip="Dismiss"] button').first())
  await expect(dismissBtn).toBeVisible({ timeout: 3_000 })

  // Click Dismiss — the hint should disappear.
  await dismissBtn.click()
  await expect(hint).not.toBeVisible({ timeout: 3_000 })
})
