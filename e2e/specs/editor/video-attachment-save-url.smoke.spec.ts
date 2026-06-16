import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VTT_FIXTURE = path.resolve(__dirname, "../../fixtures/voices-roundtrip.vtt")

/**
 * Media attachment — fills a direct media URL and attaches it.
 *
 * TimelineAddMedia.tsx has:
 *   - Media URL input
 *   - "Attach" button (disabled while URL is empty; enabled once URL is filled)
 *
 * This spec: switch to Media → type a URL → verify "Attach" is enabled.
 */
test("video attachment dialog Save URL enables after entering a URL", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `VideoURL ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(VTT_FIXTURE)
  await ws.openFileBySubstring("voices-roundtrip")
  await ws.waitForEditor()

  await alice.getByRole("button", { name: /^Media$/i }).click()

  const urlInput = alice.getByLabel("Media URL")
  await expect(urlInput).toBeVisible({ timeout: 5_000 })
  const attachBtn = alice.getByRole("button", { name: /^Attach$/i })
  await expect(attachBtn).toBeDisabled()

  await urlInput.fill("https://example.com/video.mp4")
  await expect(attachBtn).toBeEnabled({ timeout: 3_000 })
})
