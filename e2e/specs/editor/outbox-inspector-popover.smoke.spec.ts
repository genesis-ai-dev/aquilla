import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * OutboxSyncIndicator → OutboxInspectorPopover.
 *
 * The workspace footer always renders an OutboxSyncIndicator chip. In a fresh
 * project with no pending events the chip reads "Synced". Clicking it opens
 * the OutboxInspectorPopover which has:
 *   - aria-label="Outbox inspector" on the PopoverContent
 *   - <h3>Outbox</h3> heading
 *   - "All synced" text when the outbox is empty
 *
 * This spec: open a project → click the "Synced" chip → verify the Outbox
 * inspector popover opens with "All synced" text.
 */
test("outbox sync indicator opens inspector popover showing All synced", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Outbox ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The "Synced" chip button is visible in the workspace header.
  const syncedChip = alice.getByRole("button", { name: /Synced/i })
  await expect(syncedChip).toBeVisible({ timeout: 10_000 })
  await syncedChip.click()

  // OutboxInspectorPopover opens.
  const inspector = alice.locator('[aria-label="Outbox inspector"]')
  await expect(inspector).toBeVisible({ timeout: 3_000 })

  // Heading "Outbox" is present.
  await expect(inspector.getByRole("heading", { name: /Outbox/i })).toBeVisible()

  // "All synced" status is shown (empty queue).
  await expect(inspector.getByText(/All synced/i)).toBeVisible({ timeout: 3_000 })
})
