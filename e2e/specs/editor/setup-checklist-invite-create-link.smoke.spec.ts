import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * InviteStep — "Create link" generates an invite URL in the setup checklist.
 *
 * InviteStep.tsx (in the "Invite collaborators" checklist item) has an
 * "Or share a link" section with a "Create link" button. Clicking it calls
 * createServerInvite() and renders:
 *   - A read-only input containing the join URL (contains "/join/")
 *   - A Copy button (title="Copy")
 *
 * This spec: open the setup checklist → expand "Invite collaborators" →
 * click "Create link" → verify a join URL appears in the input →
 * verify the Copy button is present.
 */
test("setup checklist invite step Create link shows join URL and copy button", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `InviteLink ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the setup checklist.
  const chip = alice.locator('[title="Open setup checklist"]')
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
  const linkInput = alice.locator('input[readonly]').filter({ hasValue: /\/join\// })
  await expect(linkInput).toBeVisible({ timeout: 8_000 })

  // Copy button is present.
  const copyBtn = alice.locator('button[title="Copy"]')
  await expect(copyBtn).toBeVisible({ timeout: 2_000 })
})
