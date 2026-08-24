import { test, expect, orgRoute } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { ensureAuthState } from "../../helpers/auth"
import {
  addOrgMember,
  createOrg,
  createProjectInvite,
  createProjectServerSide,
  ROLE,
} from "../../helpers/frontier-api"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"
import { resetBackend } from "../../helpers/seed"
import {
  jwtFor,
  seedProjectWithFile,
} from "../../helpers/seed-project"

/**
 * Share / invite — InviteLinkTab chrome is one surface session (1 reset).
 * True join/accept journeys stay hermetic per-test below.
 */

test("share invite link chrome surface session", async ({ alice }) => {
  test.setTimeout(120_000)

  const seeded = await seedProjectWithFile(await jwtFor(alice.username), {
    name: `ShareInvite ${Date.now()}`,
  })

  await test.step("Invite link tab creates a link", async () => {
    const settings = new ProjectSettings(alice)
    const dialog = await settings.openInviteLinkTab(seeded.projectId)

    const createBtn = dialog.getByRole("button", { name: /Create invite link/i })
    await expect(createBtn).toBeVisible({ timeout: 3_000 })
    await expect(createBtn).toBeEnabled()
    await expect(dialog.locator("#pm-invite-email")).toBeVisible({ timeout: 3_000 })

    await createBtn.click()
    await expect(
      dialog.getByRole("button", { name: /Copy/i }).or(dialog.getByText(/\/join\//i).first()),
    ).toBeVisible({ timeout: 10_000 })
    await alice.keyboard.press("Escape")
  })

  await test.step("invite mode toggles between @user and email", async () => {
    await alice.goto(orgRoute(alice, "/members"))
    const addToProjectsBtn = alice.getByRole("button", { name: /Add to projects/i })
    await expect(addToProjectsBtn).toBeVisible({ timeout: 10_000 })
    await expect(addToProjectsBtn).toBeEnabled({ timeout: 10_000 })
    await addToProjectsBtn.click()

    const dialog = alice.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    const userModeBtn = dialog.getByRole("button", { name: "@user" })
    await expect(userModeBtn).toBeVisible({ timeout: 5_000 })
    const emailModeBtn = dialog.getByRole("button", { name: "email" })
    await expect(emailModeBtn).toBeVisible({ timeout: 3_000 })

    await emailModeBtn.click()
    const emailInput = dialog.locator('input[type="email"]#invite-recipient')
    await expect(emailInput).toBeVisible({ timeout: 5_000 })

    await userModeBtn.click()
    await expect(emailInput).not.toBeVisible({ timeout: 3_000 })
    await expect(dialog.locator('input[type="text"]#invite-recipient')).toBeVisible({
      timeout: 3_000,
    })
    await alice.keyboard.press("Escape")
  })

  await test.step("role select changes the link role", async () => {
    const settings = new ProjectSettings(alice)
    const dialog = await settings.openInviteLinkTab(seeded.projectId)
    const invitePanel = dialog.getByRole("tabpanel", { name: "Invite link" })

    const roleSelect = invitePanel.getByRole("combobox", { name: "Role", exact: true })
    await expect(roleSelect).toBeVisible({ timeout: 3_000 })

    await pickSelectOption(alice, roleSelect, /^viewer/i)
    await expectSelectValue(roleSelect, /viewer/i)
    await pickSelectOption(alice, roleSelect, /^contributor/i)
    await expectSelectValue(roleSelect, /contributor/i)
    await alice.keyboard.press("Escape")
  })

  await test.step("expiry select changes value", async () => {
    const settings = new ProjectSettings(alice)
    const dialog = await settings.openInviteLinkTab(seeded.projectId)

    const expirySelect = dialog.getByRole("combobox", { name: "Link expires" })
    await expect(expirySelect).toBeVisible({ timeout: 3_000 })
    await expectSelectValue(expirySelect, "7 days (default)")

    await pickSelectOption(alice, expirySelect, "No expiry")
    await expectSelectValue(expirySelect, "No expiry")
    await pickSelectOption(alice, expirySelect, "1 day")
    await expectSelectValue(expirySelect, "1 day")
    await alice.keyboard.press("Escape")
  })

  await test.step("Copy URL shows Copied confirmation", async () => {
    const settings = new ProjectSettings(alice)
    const dialog = await settings.openInviteLinkTab(seeded.projectId)

    const createBtn = dialog.getByRole("button", { name: /Create invite link/i })
    await expect(createBtn).toBeVisible({ timeout: 5_000 })
    await createBtn.click()

    const copyBtn = dialog.getByRole("button", { name: "Copy URL" }).first()
    await expect(copyBtn).toBeVisible({ timeout: 10_000 })
    await copyBtn.click()
    await expect(dialog.getByText(/Copied!/i)).toBeVisible({ timeout: 3_000 })
    await alice.keyboard.press("Escape")
  })

  await test.step("invalid email shows validation error", async () => {
    const settings = new ProjectSettings(alice)
    const dialog = await settings.openInviteLinkTab(seeded.projectId)

    const emailInput = dialog.locator("#pm-invite-email")
    await expect(emailInput).toBeVisible({ timeout: 3_000 })
    await emailInput.fill("not-an-email")

    await dialog.getByRole("button", { name: /Create invite link/i }).click()
    await expect(
      dialog.getByText(/Enter a valid email address, or leave blank for an open link/i),
    ).toBeVisible({ timeout: 3_000 })
    await alice.keyboard.press("Escape")
  })
})

test("share panel username typeahead shows Verified Aquilla user badge", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const searchScopeOrg = await createOrg(
    aliceSession.jwt,
    `Z Verified Badge Search Scope ${Date.now()}`,
  )
  await addOrgMember(aliceSession.jwt, searchScopeOrg.id, "bob", ROLE.VIEWER)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `VerifiedBadge ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await expect(alice).toHaveURL(/\/projects\/[^/?#]+/, { timeout: 15_000 })

  const settings = new ProjectSettings(alice)
  const dialog = await settings.openAddMemberDialog(settings.projectIdFromCurrentUrl())

  const usernameInput = dialog
    .locator('input[placeholder*="username" i]')
    .or(dialog.locator('input[placeholder="Aquilla username"]'))
  await expect(usernameInput).toBeVisible({ timeout: 8_000 })

  await usernameInput.fill("bob")
  const suggestion = alice.getByRole("checkbox", { name: "bob" })
  await expect(suggestion).toBeVisible({ timeout: 8_000 })
  await suggestion.click()

  await expect(dialog.getByRole("button", { name: "Remove bob" })).toBeVisible({
    timeout: 8_000,
  })
  await expect(dialog.getByText("bob").first()).toBeVisible()
  await alice.keyboard.press("Escape")
})

test("join page with invalid token shows error state and Back to projects", async ({ alice }) => {
  await alice.goto("/join/invalid-token-e2e-test")

  await expect(alice.getByText(/Joining Project/i).first()).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByRole("button", { name: /Back to projects/i })).toBeVisible({
    timeout: 10_000,
  })

  await alice.getByRole("button", { name: /Back to projects/i }).click()
  await expect(alice).toHaveURL(/\/orgs\/[^/?]+(\/overview)?$/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: "Acme", exact: true })).toBeVisible()
})

test("join page names the inviter and workspace on a real invite", async ({ bob }) => {
  // bob-only fixture: reset explicitly (alice fixture is what normally wipes).
  await resetBackend()

  const aliceSession = await ensureAuthState("alice")
  const proj = await createProjectServerSide(aliceSession.jwt, {
    id: `join-ctx-${Date.now()}`,
    name: `JoinCtx ${Date.now()}`,
  })
  const invite = await createProjectInvite(aliceSession.jwt, proj.id)

  await bob.goto(`/join/${invite.token}`)
  await expect(bob.getByText(proj.name)).toBeVisible({ timeout: 10_000 })
  await expect(bob.getByText(/Invited by/i)).toBeVisible()
  await expect(bob.getByText("alice", { exact: true })).toBeVisible()
  await expect(bob.getByRole("button", { name: /Accept invitation/i })).toBeVisible()
})

test("invite accept shows confirmation and the project surfaces on the invitee's dashboard", async ({
  alice,
  bob,
}) => {
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

  await bob.goto("/orgs/all")
  await expect(bob.getByTestId("project-table").getByText(name)).toBeVisible({ timeout: 10_000 })
  await expect(bob.getByTestId("shared-filter-chip")).toBeVisible()
})
