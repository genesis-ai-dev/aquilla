import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * InviteStep — "Create link" generates an invite URL in the setup checklist.
 *
 * InviteStep.tsx (in the "Invite collaborators" checklist item) has an
 * "Or share a link" section with a "Create link" button. Clicking it calls
 * createServerInvite() and renders:
 *   - A read-only input containing the join URL (contains "/join/")
 *   - A Copy button with a tooltip
 *
 * This spec: open the setup checklist → expand "Invite collaborators" →
 * click "Create link" → verify a join URL appears in the input →
 * verify the Copy button is present.
 */
test("setup checklist invite step Create link shows join URL and copy button", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `InviteLink ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Open the setup checklist.
  const chip = alice.getByRole("button", { name: /Setup:/i })
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()

  await expect(alice.getByRole("heading", { name: /Project setup/i })).toBeVisible({
    timeout: 5_000,
  })

  // Expand the "Invite collaborators" checklist item.
  const inviteItem = alice.locator("button[aria-expanded]").filter({
    hasText: /Invite collaborators/i,
  })
  await expect(inviteItem).toBeVisible({ timeout: 5_000 })

  const isExpanded = await inviteItem.getAttribute("aria-expanded")
  if (isExpanded !== "true") {
    await inviteItem.click()
  }
  await expect(inviteItem).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 })

  // "Or share a link" section with "Create link" button is visible.
  const createLinkBtn = alice.getByRole("button", { name: /Create link/i })
  await expect(createLinkBtn).toBeVisible({ timeout: 3_000 })
  await createLinkBtn.click()

  // A join URL appears in a read-only input.
  const linkInput = alice.locator('input[readonly]').first()
  await expect(linkInput).toBeVisible({ timeout: 8_000 })
  await expect(linkInput).toHaveValue(/\/join\//, { timeout: 8_000 })

  // Copy button is present (InviteStep aria-label).
  const copyBtn = alice.getByRole("button", { name: /Copy invite link/i }).first()
  await expect(copyBtn).toBeVisible({ timeout: 2_000 })
})
