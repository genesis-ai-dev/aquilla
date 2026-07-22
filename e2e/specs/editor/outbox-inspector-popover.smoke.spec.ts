import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * OutboxSyncIndicator → OutboxInspectorPopover.
 *
 * The workspace footer always renders an OutboxSyncIndicator chip. In a fresh
 * project with no pending events the chip reads "Synced". Clicking it opens
 * the OutboxInspectorPopover which has:
 *   - aria-label="Pending changes" on the PopoverContent
 *   - <h3>Outbox</h3> heading
 *   - "All synced" text when the outbox is empty
 *
 * This spec: open a project → click the "Synced" chip → verify the Outbox
 * inspector popover opens with "All synced" text.
 */
test("outbox sync indicator opens inspector popover showing All synced", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Outbox ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // The "Synced" chip button is visible in the workspace header.
  const syncedChip = alice.getByRole("button", { name: /Synced/i })
  await expect(syncedChip).toBeVisible({ timeout: 10_000 })
  await syncedChip.click()

  // OutboxInspectorPopover opens (PopoverContent aria-label="Pending changes").
  const inspector = alice.locator('[aria-label="Pending changes"]')
  await expect(inspector).toBeVisible({ timeout: 3_000 })

  // Heading "Outbox" is present.
  await expect(inspector.getByRole("heading", { name: /Outbox/i })).toBeVisible()

  // "All synced" status is shown (empty queue).
  await expect(inspector.getByText(/All synced/i)).toBeVisible({ timeout: 3_000 })
})
