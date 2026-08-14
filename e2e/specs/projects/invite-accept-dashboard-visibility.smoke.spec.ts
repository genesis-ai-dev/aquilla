import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

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
 *   2. AQU-417: cross-org grants are collected on a single dedicated page
 *      (/shared), reached from the sidebar's "Shared with you" link — instead
 *      of being scattered under every org's dashboard.
 */
test("invite accept shows confirmation and the project surfaces on the invitee's dashboard", async ({ alice, bob }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Invited ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await expect(alice).toHaveURL(/\/projects\/[^/?#]+/, { timeout: 15_000 })

  const settings = new ProjectSettings(alice)
  const dialog = await settings.openInviteLinkTab(settings.projectIdFromCurrentUrl())
  await dialog.getByRole("button", { name: /Create invite link/i }).click()

  const urlInput = dialog.locator("input[readonly]")
  await expect(urlInput).toBeVisible({ timeout: 10_000 })
  const inviteUrl = await urlInput.inputValue()
  const joinPath = new URL(inviteUrl).pathname
  expect(joinPath).toMatch(/^\/join\//)

  await bob.goto(joinPath)
  const acceptBtn = bob.getByRole("button", { name: /Accept invitation/i })
  await expect(acceptBtn).toBeVisible({ timeout: 10_000 })
  await expect(bob.getByText(name)).toBeVisible({ timeout: 10_000 })

  await acceptBtn.click()
  await bob.waitForURL(/\/project\//, { timeout: 15_000 })

  await bob.goto("/")
  const sharedLink = bob.getByRole("link", { name: "Shared with you" })
  await expect(sharedLink).toBeVisible({ timeout: 10_000 })
  await sharedLink.click()
  await bob.waitForURL(/\/shared$/, { timeout: 10_000 })

  const shared = bob.getByTestId("shared-with-you")
  await expect(shared).toBeVisible({ timeout: 10_000 })
  await expect(shared.getByText(name)).toBeVisible()
})
