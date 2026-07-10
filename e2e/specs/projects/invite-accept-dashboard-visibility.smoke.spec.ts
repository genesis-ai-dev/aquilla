import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * AQU-335 — magic-link invite accept must leave the project REACHABLE.
 *
 * The failure mode this guards against: bob redeems alice's invite link,
 * lands in the workspace, then closes the tab — and the project never
 * appears on his dashboard because every nav surface was scoped to orgs he
 * belongs to (the project lives in ALICE's org). The fix:
 *
 *   1. JoinPage shows an explicit "Accept invitation" confirmation for
 *      signed-in users (spec join-via-invite-link Step 2) instead of a
 *      silent auto-accept on link-open.
 *   2. /projects partitions the unfiltered accessible-projects list and
 *      renders cross-org grants under "Shared with you".
 */
test("invite accept shows confirmation and the project surfaces on the invitee's dashboard", async ({ alice, bob }) => {
  // ── alice: create a project and mint an invite link ──
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Invited ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  // No file import needed — the Share dialog works on an empty project, and
  // skipping the import keeps this spec independent of the importer flow.
  await alice.getByRole("button", { name: /More project options/i }).click()
  await alice.getByRole("button", { name: /^Share$/i }).click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole("button", { name: /^Invite link$/i }).click()
  await dialog.getByRole("button", { name: /Create invite link/i }).click()

  // The issued URL renders in a readonly input.
  const urlInput = dialog.locator("input[readonly]")
  await expect(urlInput).toBeVisible({ timeout: 10_000 })
  const inviteUrl = await urlInput.inputValue()
  const joinPath = new URL(inviteUrl).pathname
  expect(joinPath).toMatch(/^\/join\//)

  // ── bob: open the link — must see a confirmation, not a silent join ──
  await bob.goto(joinPath)
  const acceptBtn = bob.getByRole("button", { name: /Accept invitation/i })
  await expect(acceptBtn).toBeVisible({ timeout: 10_000 })
  // Invite preview names the project before bob commits.
  await expect(bob.getByText(name)).toBeVisible({ timeout: 10_000 })

  await acceptBtn.click()
  await bob.waitForURL(/\/project\//, { timeout: 15_000 })

  // ── bob: the project is now reachable from the dashboard ──
  await bob.goto("/projects")
  const shared = bob.getByTestId("shared-with-you")
  await expect(shared).toBeVisible({ timeout: 10_000 })
  await expect(shared.getByText(name)).toBeVisible()

  // And from the Overview (dashboard root) as well.
  await bob.goto("/")
  const overviewShared = bob.getByTestId("shared-with-you")
  await expect(overviewShared).toBeVisible({ timeout: 10_000 })
  await expect(overviewShared.getByText(name)).toBeVisible()
})
