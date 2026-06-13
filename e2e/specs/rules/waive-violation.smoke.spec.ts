import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ViolationPopover — waive and unwaive a violation.
 *
 * The ViolationPopover now opens from the cell expansion's "Issues" tab
 * (EditorTable.tsx: each infraction row button calls setOpenRuleId) or by
 * clicking an inline rule blot — the old standalone infraction badge is
 * gone (the number pill's hover popover is informational only). The
 * popover has:
 *   - "Waive" button → shows reason input + "Confirm" and "Cancel" buttons
 *   - Confirming the waive CLOSES the popover (EditorTable.handleWaive calls
 *     setOpenRuleId(null)) and the infraction moves to the Issues tab's
 *     "Waived" subsection.
 *   - Reopening the popover from the waived row shows the waiver details and
 *     an "Unwaive" button; clicking it closes the popover again and moves
 *     the infraction back to the active list.
 *
 * This spec: enable Extra whitespace rule → create violation → open the
 * cell expansion → Issues tab → click the infraction → Waive → reason →
 * Confirm → infraction shows under "Waived" → reopen popover → Unwaive →
 * waived section empties and the active infraction's popover offers Waive
 * again.
 */
test("waive and unwaive a rule violation via violation popover", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Waive ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // Enable Extra whitespace rule (shadcn Switch, role="switch").
  await alice.goto(`/project/${projectId}/rules`)
  const toggle = alice.getByRole("switch", { name: /Extra whitespace enabled/i })
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 3_000 })
  }

  // Import file and create a violation.
  await alice.goto(`/project/${projectId}`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  const editable = row.locator('textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"]').first()
  await editable.waitFor({ state: "visible", timeout: 10_000 })
  await editable.click()
  await alice.keyboard.insertText("double  space  text")
  await alice.locator("aside").click()

  // Open the cell expansion (chevron rail button, aria-label from tooltip).
  await row.hover()
  const expandBtn = row.getByRole("button", { name: "Open cell details" })
  await expect(expandBtn).toBeVisible({ timeout: 10_000 })
  await expandBtn.click()

  // Switch to the Issues tab and click the Extra whitespace infraction —
  // this anchors and opens the ViolationPopover.
  const issuesTab = row.getByRole("tab", { name: /Issues/i })
  await expect(issuesTab).toBeEnabled({ timeout: 10_000 })
  await issuesTab.click()
  const infractionBtn = row.getByRole("button", { name: /Extra whitespace/i }).first()
  await expect(infractionBtn).toBeVisible({ timeout: 10_000 })
  await infractionBtn.click()

  // ViolationPopover is open — "Waive" button visible.
  const waiveBtn = alice.getByRole("button", { name: /^Waive$/i }).first()
  await expect(waiveBtn).toBeVisible({ timeout: 5_000 })
  await waiveBtn.click()

  // Waive reason form: optional input + Confirm + Cancel.
  const reasonInput = alice.locator('input[placeholder="Reason (optional)"]')
  await expect(reasonInput).toBeVisible({ timeout: 3_000 })
  await reasonInput.fill("intentional for testing")

  const confirmBtn = alice.getByRole("button", { name: /^Confirm$/i })
  await expect(confirmBtn).toBeVisible({ timeout: 3_000 })
  await confirmBtn.click()

  // Confirming closes the popover and the infraction visibly moves to the
  // Issues tab's "Waived" subsection (pending-outbox overlay reflects the
  // cell.waive event immediately).
  const waivedHeader = row.getByText("Waived", { exact: true })
  await expect(waivedHeader).toBeVisible({ timeout: 10_000 })
  const waivedRow = row.getByRole("button", { name: /^Extra whitespace$/i })
  await expect(waivedRow).toBeVisible({ timeout: 5_000 })

  // Reopen the popover from the waived row — it now shows the waiver details
  // (including our reason) and the "Unwaive" button.
  await waivedRow.click()
  await expect(alice.getByText("intentional for testing")).toBeVisible({ timeout: 5_000 })
  const unwaiveBtn = alice.getByRole("button", { name: /^Unwaive$/i })
  await expect(unwaiveBtn).toBeVisible({ timeout: 5_000 })

  // Unwaive — popover closes, the "Waived" subsection empties, and the
  // infraction is active again: reopening its popover offers "Waive".
  await unwaiveBtn.click()
  await expect(waivedHeader).toBeHidden({ timeout: 10_000 })
  const activeInfraction = row.getByRole("button", { name: /Extra whitespace/i }).first()
  await expect(activeInfraction).toBeVisible({ timeout: 5_000 })
  await activeInfraction.click()
  await expect(alice.getByRole("button", { name: /^Waive$/i }).first()).toBeVisible({ timeout: 5_000 })
})
