import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ViewSettingsMenu — text direction modes.
 *
 * The menu (opened via header ⋯ → "View settings", FRO-331) exposes explicit
 * Auto / LTR / RTL controls for the source and target columns.
 */
test("view settings text direction Source mode can force RTL and return to Auto", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TextDir ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the view settings menu from the header overflow menu (FRO-331).
  await ws.openViewSettingsMenu()

  const menu = alice.getByRole("menu")
  await expect(menu.getByText("Text Direction")).toBeVisible({ timeout: 3_000 })

  const sourceText = alice.locator('[data-cell-type="source"]').first()
  await expect(sourceText).toHaveAttribute("dir", "ltr")

  const sourceAuto = menu.getByRole("button", { name: "Source direction Auto" })
  const sourceRtl = menu.getByRole("button", { name: "Source direction RTL" })
  await expect(sourceAuto).toHaveAttribute("aria-pressed", "true")

  await sourceRtl.click()
  await expect(sourceRtl).toHaveAttribute("aria-pressed", "true")
  await expect(sourceText).toHaveAttribute("dir", "rtl")

  await sourceAuto.click()
  await expect(sourceAuto).toHaveAttribute("aria-pressed", "true")
  await expect(sourceText).toHaveAttribute("dir", "ltr")

  // Close menu.
  await alice.keyboard.press("Escape")
})
