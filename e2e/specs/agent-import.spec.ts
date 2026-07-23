import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../helpers/multi-user"
import { Dashboard } from "../helpers/page-objects/Dashboard"
import { Workspace } from "../helpers/page-objects/Workspace"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LEGACY_XLSX = path.resolve(__dirname, "../fixtures/agent/legacy-export.xlsx")

/**
 * The container-backed path is intentionally outside the <2 minute smoke
 * gate. Run with AGENT_SANDBOX_E2E=1 once a local or deployed sandbox endpoint
 * is configured; ordinary `pnpm dev` remains usable without that capability.
 */
test.skip(
  !process.env.AGENT_SANDBOX_E2E,
  "requires the isolated import sandbox; set AGENT_SANDBOX_E2E=1 when it is provisioned",
)

test("Import dialog parses an unsupported legacy container in the sandbox, previews it, and commits through the normal gateway", async ({
  alice,
}) => {
  test.setTimeout(240_000)
  const dashboard = new Dashboard(alice)
  await dashboard.goto()
  const projectName = `Sandbox Import ${Date.now()}`
  await dashboard.createProject({ name: projectName, source: "en", target: "fr" })
  await dashboard.openProject(projectName)

  const workspace = new Workspace(alice)
  await workspace.previewImportPayload({
    name: "legacy-export.odd",
    mimeType: "application/octet-stream",
    buffer: readFileSync(LEGACY_XLSX),
  })

  const classification = alice.getByTestId("ai-import-classification")
  await expect(classification).toContainText("AI-assisted structure")
  await expect(classification).toContainText(/Recipe:/)
  await expect(alice.getByText("In the beginning God created", { exact: false })).toBeVisible()

  await workspace.confirmImportPreview()
  await workspace.openFileBySubstring("legacy-export.odd")
  await workspace.waitForEditor()
  await expect(workspace.cellRow(0)).toContainText("In the beginning God created")
  await expect(workspace.cellRow(0).locator('[data-cell-type="target"]')).toContainText("Au commencement", { timeout: 15_000 })
})
