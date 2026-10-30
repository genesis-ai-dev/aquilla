import type { Locator } from "@playwright/test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Client } from "pg"
import { test, expect, orgRoute } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { ensureAuthState } from "../../helpers/auth"
import {
  addOrgMember,
  createOrg,
  createOrgInvite,
  createProjectInvite,
  createProjectServerSide,
  listMyOrgs,
  ROLE,
} from "../../helpers/frontier-api"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"
import { resetBackend } from "../../helpers/seed"
import {
  jwtFor,
  seedProjectWithFile,
} from "../../helpers/seed-project"

test("org invitation grants membership and remains usable by its member redeemer", async ({ alice, bob }) => {
  const org = await createOrg(await jwtFor(alice.username), "Invitation preview regression")
  const { token } = await createOrgInvite(await jwtFor(alice.username), org.id)
  await bob.goto(`/join-org/${token}`)
  await expect(bob.getByText(org.name!, { exact: true })).toBeVisible()
  await bob.getByRole("button", { name: "Accept invitation", exact: true }).click()
  await expect(bob).toHaveURL(new RegExp(`/orgs/${org.id}(?:/|$)`))
  expect((await listMyOrgs(await jwtFor(bob.username))).some((item) => item.id === org.id)).toBe(true)

  // A used token is unavailable anonymously, but the server permits the same
  // still-member redeemer. The preview must send that caller's session.
  await bob.goto(`/join-org/${token}`)
  await expect(bob.getByRole("button", { name: "Accept invitation", exact: true })).toBeVisible()
})

/**
 * Share / invite — InviteLinkTab chrome is one surface session (1 reset).
 * True join/accept journeys stay hermetic per-test below.
 */

/** A project with a target lane will not mint a link until this is chosen. */
async function chooseEveryCurrentLane(dialog: Locator) {
  const every = dialog.getByRole("radio", { name: /Every current target lane/i })
  await expect(every).toBeVisible({ timeout: 10_000 })
  await every.check()
}

test("org invitation survives password recovery in a fresh browser session", async ({ page, browser, baseURL, request }) => {
  await resetBackend()
  // Recover an existing, verified account. The shared seed intentionally has
  // unverified email addresses, which cannot accept email-bound invitations.
  const database = new URL(process.env.E2E_DATABASE_URL ?? "")
  if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname)
    || !/^\/aquilla_e2e(?:_s\d+)?$/.test(database.pathname)) {
    throw new Error("Recovery fixture requires a local E2E database")
  }
  const db = new Client({ connectionString: database.toString() })
  await db.connect()
  try {
    const verified = await db.query("UPDATE users SET email_verified_at = now() WHERE username = 'bob'")
    expect(verified.rowCount).toBe(1)
  } finally { await db.end() }
  const alice = await ensureAuthState("alice")
  const org = await createOrg(alice.jwt, "Recovery invitation workspace")
  const invite = await createOrgInvite(alice.jwt, org.id, { email: "bob@example.test", role: ROLE.VIEWER })
  const returnTo = `/join-org/${invite.token}`
  await page.goto(returnTo)
  await page.getByRole("button", { name: /forgot password/i }).click()
  await expect(page.getByText(org.name!, { exact: true })).toBeVisible()
  await page.getByLabel("Email", { exact: true }).fill("bob@example.test")
  const resetRequested = page.waitForResponse(r => r.url().endsWith("/password-reset/request") && r.request().method() === "POST")
  await page.getByRole("button", { name: /send reset link/i }).click()
  const response = await resetRequested
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON()).toEqual({ email: "bob@example.test", return_to: returnTo })

  // Miniflare captures outbound mail locally. Consume the actual handler's
  // email (including its reset token and returnTo), without sending real mail
  // or replacing auth responses. The unique invitation identifies this mail.
  const mailRoot = path.resolve("auth-worker/.wrangler/tmp/email")
  let resetUrl: URL | undefined
  await expect.poll(() => {
    const files = existsSync(mailRoot) ? readdirSync(mailRoot, { recursive: true, encoding: "utf8" }) : []
    for (const file of files.filter(f => f.includes("email-text/") && f.endsWith(".txt"))) {
      const text = readFileSync(path.join(mailRoot, file), "utf8")
      const link = text.match(/https?:\/\/\S+\/reset-password\?\S+/)?.[0]
      if (!link) continue
      const url = new URL(link)
      if (url.searchParams.get("returnTo") === returnTo && url.searchParams.get("username") === "bob") {
        resetUrl = url
        return true
      }
    }
    return false
  }, { message: "reset email contains the original invitation" }).toBe(true)

  const fresh = await browser.newContext({ baseURL })
  try {
    const recovery = await fresh.newPage()
    await recovery.goto(`${resetUrl!.pathname}${resetUrl!.search}`)
    await recovery.getByLabel("New password", { exact: true }).fill("RecoveredPassword123!")
    await recovery.getByRole("button", { name: /set new password/i }).click()
    await expect(recovery).toHaveURL(new RegExp(`${returnTo}$`))
    await expect(recovery.getByRole("button", { name: /accept invitation/i })).toBeVisible()
    const authBase = process.env.VITE_AUTH_BASE ?? process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
    const login = await request.post(`${authBase}/api/v2/auth/token`, {
      data: { username: "bob", password: "RecoveredPassword123!" },
    })
    expect(login.status()).toBe(200)
    const jwt = (await login.json()).access_token as string
    expect((await listMyOrgs(jwt)).some(o => o.id === org.id)).toBe(false)
    await recovery.getByRole("button", { name: /accept invitation/i }).click()
    await expect.poll(async () => (await listMyOrgs(jwt)).some(o => o.id === org.id)).toBe(true)
  } finally { await fresh.close() }
})

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
    await chooseEveryCurrentLane(dialog)
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

    // AQU-1153: the recipient mode switch is the app's shared Tabs control, so
    // the two options are `tab`s in a `tablist` and the current mode is the
    // selected tab — not a pair of hand-rolled buttons.
    const modeTabs = dialog.getByRole("tablist")
    await expect(modeTabs).toBeVisible({ timeout: 5_000 })
    const userModeTab = modeTabs.getByRole("tab", { name: "@user" })
    await expect(userModeTab).toBeVisible({ timeout: 5_000 })
    const emailModeTab = modeTabs.getByRole("tab", { name: /^email$/i })
    await expect(emailModeTab).toBeVisible({ timeout: 3_000 })
    await expect(userModeTab).toHaveAttribute("aria-selected", "true")
    await expect(emailModeTab).toHaveAttribute("aria-selected", "false")

    await emailModeTab.click()
    await expect(emailModeTab).toHaveAttribute("aria-selected", "true")
    await expect(userModeTab).toHaveAttribute("aria-selected", "false")
    const emailInput = dialog.locator('input[type="email"]#invite-recipient')
    await expect(emailInput).toBeVisible({ timeout: 5_000 })

    await userModeTab.click()
    await expect(userModeTab).toHaveAttribute("aria-selected", "true")
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
    await chooseEveryCurrentLane(dialog)
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
    await chooseEveryCurrentLane(dialog)

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
  await chooseEveryCurrentLane(dialog)
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
