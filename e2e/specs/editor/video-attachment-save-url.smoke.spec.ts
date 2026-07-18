import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VTT_FIXTURE = path.resolve(__dirname, "../../fixtures/voices-roundtrip.vtt")

/**
 * Video attachment dialog — Save URL stays enabled and validates empty URL.
 */
test("video attachment dialog Save URL validates empty URL on click", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `VideoURL ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(VTT_FIXTURE)
  await ws.openFileBySubstring("voices-roundtrip")
  await ws.waitForEditor()

  const moreBtn = alice.getByRole("banner").getByRole("button", { name: /^More$/i })
  await expect(moreBtn).toBeVisible({ timeout: 10_000 })
  await moreBtn.click()

  const attachVideoItem = alice.getByRole("menuitem", { name: /Attach video/i })
  await expect(attachVideoItem).toBeVisible({ timeout: 3_000 })
  await attachVideoItem.click()

  const dialog = alice.getByRole("dialog").filter({ hasText: "Attach Video" })
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Attach Video/i })).toBeVisible()
  await dialog.getByRole("button", { name: /From URL/i }).click()

  const urlInput = dialog.getByLabel("Video URL")
  await expect(urlInput).toBeVisible({ timeout: 5_000 })
  const saveUrlBtn = dialog.getByRole("button", { name: /^Save URL$/i })
  await expect(saveUrlBtn).toBeEnabled()

  await saveUrlBtn.click()
  await expect(dialog.getByText(/enter a video url/i)).toBeVisible({ timeout: 2_000 })

  await urlInput.fill("https://example.com/video.mp4")
  await expect(saveUrlBtn).toBeEnabled({ timeout: 3_000 })
})
