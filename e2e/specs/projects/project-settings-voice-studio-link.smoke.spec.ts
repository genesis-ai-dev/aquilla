import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — Voice section "Open Voice Studio" button.
 *
 * The Voice section (id="section-voice") in ProjectSettings renders:
 *   - CardTitle "Voice"
 *   - "Open Voice Studio" button that navigates to /project/:id/editor
 *     (with the audio lens preference set in localStorage)
 *
 * This spec: navigate to /project/:id/settings → verify "Open Voice Studio"
 * button is visible → click it → URL changes to /project/:id/editor
 */
test("project settings Voice section Open Voice Studio button navigates to workspace", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `VoiceLink ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1] ?? ""

  await alice.goto(`/project/${projectId}/settings/ai`)
  // "Open Voice Studio" button is visible in the Voice section.
  const voiceStudioBtn = alice.getByRole("button", { name: /Open Voice Studio/i })
  await expect(voiceStudioBtn).toBeVisible({ timeout: 10_000 })
  await voiceStudioBtn.click()

  // URL changes to /project/:id/editor (the workspace, opens in audio lens mode).
  await alice.waitForURL(new RegExp(`/project/${projectId}/editor`), { timeout: 8_000 })
})
