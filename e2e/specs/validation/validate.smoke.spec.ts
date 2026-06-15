import { expect, test } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("alice validates a cell and the indicator turns emerald", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Validate ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await ws.editCell(0, "Test translation")

  const row = ws.cellRow(0)
  const unvalidatedButton = row.getByRole("button", { name: /Validate/i }).first()
  await expect(unvalidatedButton).toHaveAttribute("data-slot", "tooltip-trigger")
  await expect(unvalidatedButton).toHaveAttribute("data-tooltip", /Not validated/)
  await expect(unvalidatedButton).not.toHaveAttribute("title", /.+/)
  await unvalidatedButton.hover()
  await expect(alice.locator('[data-slot="tooltip-content"]').filter({ hasText: /Not validated/ })).toBeVisible()

  // validateCell asserts the emerald indicator appears.
  await ws.validateCell(0)
  const validatedButton = row.getByRole("button", { name: /Validated/i }).first()
  await expect(validatedButton).not.toHaveAttribute("title", /.+/)
})
