import { test, expect, orgRoute } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Teams — create, members, projects, settings, sort/filter.
 */

test("create a team and navigate to its detail page", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/teams"))
  // 1. "New team" button is visible (only rendered for owners/admins).
  const newTeamBtn = alice.getByRole("button", { name: /New team/i })
  await expect(newTeamBtn).toBeVisible({ timeout: 10_000 })
  await newTeamBtn.click()

  // 2. Inline form appears with "Team name" placeholder input.
  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })

  const teamName = `E2E Team ${Date.now()}`
  await nameInput.fill(teamName)

  // 3. Submit the form — "Create" button.
  await alice.getByRole("button", { name: /^Create$/i }).click()

  // The form navigates to /teams/:groupId on success.
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  // 4. The team detail page shows the team name.
  await expect(alice.getByText(teamName).first()).toBeVisible({ timeout: 5_000 })
})

test("team add member workflow shows new member in members list", async ({ alice }) => {
  // Seed bob in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  await alice.goto(orgRoute(alice, "/teams"))
  // Create a team.
  await alice.getByRole("button", { name: /New team/i }).click()
  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const teamName = `AddMemberTeam ${Date.now()}`
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /^Create$/i }).click()
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  // Members live on the Members tab (Linear-style team page).
  await alice.getByRole("tab", { name: /^Members$/i }).click()
  // "Add a member" button appears for admin.
  const addMemberBtn = alice.getByRole("button", { name: /Add (a )?member/i })
  await expect(addMemberBtn).toBeVisible({ timeout: 5_000 })
  await addMemberBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  await expect(dialog.getByRole("heading", { name: new RegExp(`Add members to '${teamName}'`) })).toBeVisible()

  // Open the multi-select combobox and pick bob (checkbox + avatar + username option).
  const memberSelect = dialog.getByRole("combobox", { name: "Members to add" })
  await expect(memberSelect).toBeVisible({ timeout: 3_000 })
  await memberSelect.click()
  const bobOption = alice.getByRole("option", { name: "bob" })
  await expect(bobOption).toBeVisible({ timeout: 3_000 })
  await bobOption.click()
  await expect(memberSelect).toContainText("bob", { timeout: 3_000 })

  // Click Add — enabled once someone is staged.
  const addBtn = dialog.getByRole("button", { name: /^Add$/i })
  await expect(addBtn).toBeEnabled({ timeout: 3_000 })
  await addBtn.click()

  // Bob appears in the Members list (row actions menu is unique to the member).
  await expect(alice.getByRole("button", { name: /Actions for bob/i })).toBeVisible({ timeout: 5_000 })
})

test("team remove member button removes the member from the team", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Navigate to teams and create a team.
  await alice.goto(orgRoute(alice, "/teams"))
  const dash = new Dashboard(alice)
  void dash // suppress unused var
  const createBtn = alice.getByRole("button", { name: /\+ New team|Create team|New team/i })
  await expect(createBtn).toBeVisible({ timeout: 30_000 })
  await createBtn.click()

  const teamName = `RemoveMember ${Date.now()}`
  const createDialog = alice.getByRole("dialog")
  await expect(createDialog).toBeVisible({ timeout: 3_000 })
  const nameInput = createDialog.getByLabel(/^Team name$/i)
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await createDialog.getByRole("button", { name: /^Create$/i }).click()

  // Creating a team auto-navigates to its detail page (/teams/:id) — no click
  // needed. (A team-name locator would resolve to the breadcrumb "current page"
  // span, which is aria-disabled, so clicking it hangs until the test times out.)
  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })

  // Members live on the Members tab (Linear-style team page).
  await alice.getByRole("tab", { name: /^Members$/i }).click()

  // Add bob to the team via multi-select (AQU-735).
  const addMemberBtn = alice.getByRole("button", { name: /Add (a )?member/i })
  await expect(addMemberBtn).toBeVisible({ timeout: 5_000 })
  await addMemberBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  const memberSelect = dialog.getByRole("combobox", { name: "Members to add" })
  await expect(memberSelect).toBeVisible({ timeout: 3_000 })
  await memberSelect.click()
  const bobOption = alice.getByRole("option", { name: "bob" })
  await expect(bobOption).toBeVisible({ timeout: 3_000 })
  await bobOption.click()
  const confirmAdd = dialog.getByRole("button", { name: /^Add$/i })
  await expect(confirmAdd).toBeEnabled({ timeout: 3_000 })
  await confirmAdd.click()

  // Wait for bob's member row, then remove via the three-dot menu.
  const actionsBtn = alice.getByRole("button", { name: /Actions for bob/i })
  await expect(actionsBtn).toBeVisible({ timeout: 8_000 })
  await actionsBtn.click()
  const removeItem = alice.getByRole("menuitem", { name: /Remove from team/i })
  await expect(removeItem).toBeVisible({ timeout: 3_000 })
  await removeItem.click()

  // Bob's row is gone (the actions trigger disappears with it).
  await expect(actionsBtn).not.toBeVisible({ timeout: 5_000 })
})

test("team member role select changes member role", async ({ alice }) => {
  // Seed bob in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Create a team.
  await alice.goto(orgRoute(alice, "/teams"))
  const createBtn = alice.getByRole("button", { name: /\+ New team|Create team|New team/i })
  await expect(createBtn).toBeVisible({ timeout: 30_000 })
  await createBtn.click()

  const teamName = `RoleTeam ${Date.now()}`
  const createDialog = alice.getByRole("dialog")
  await expect(createDialog).toBeVisible({ timeout: 3_000 })
  const nameInput = createDialog.getByLabel(/^Team name$/i)
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await createDialog.getByRole("button", { name: /^Create$/i }).click()

  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: teamName })).toBeVisible({ timeout: 5_000 })

  // Members live on the Members tab (Linear-style team page).
  await alice.getByRole("tab", { name: /^Members$/i }).click()

  // Add bob via the multi-select "Members to add" combobox (AQU-735).
  const addMemberBtn = alice.getByRole("button", { name: /Add (a )?member/i })
  await expect(addMemberBtn).toBeVisible({ timeout: 10_000 })
  await addMemberBtn.click()

  const addDialog = alice.getByRole("dialog")
  await expect(addDialog).toBeVisible({ timeout: 3_000 })
  const memberSelect = addDialog.getByRole("combobox", { name: "Members to add" })
  await expect(memberSelect).toBeVisible({ timeout: 3_000 })
  await memberSelect.click()
  const bobOption = alice.getByRole("option", { name: "bob" })
  await expect(bobOption).toBeVisible({ timeout: 3_000 })
  await bobOption.click()

  const addBtn = addDialog.getByRole("button", { name: /^Add$/i })
  await expect(addBtn).toBeEnabled({ timeout: 3_000 })
  await addBtn.click()

  // Bob now appears in the member list.
  const actionsBtn = alice.getByRole("button", { name: /Actions for bob/i })
  await expect(actionsBtn).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByText("Contributor")).toBeVisible({ timeout: 5_000 })

  // Open Change role dialog from the three-dot menu.
  await actionsBtn.click()
  await alice.getByRole("menuitem", { name: /Change role/i }).click()
  const roleDialog = alice.getByRole("dialog", { name: /Change role for bob/i })
  await expect(roleDialog).toBeVisible({ timeout: 3_000 })

  const roleSelect = roleDialog.getByRole("combobox", { name: "Role for bob" })
  await expect(roleSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, roleSelect, /^Maintainer\b/i)
  await expectSelectValue(roleSelect, /Maintainer/i)
  await roleDialog.getByRole("button", { name: /^Save$/i }).click()

  // Wait for the dialog to close, then assert the Role column (avoid matching
  // leftover select/portal text that also contains "maintainer").
  await expect(alice.getByRole("dialog", { name: /Change role for bob/i })).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByRole("row", { name: /bob/i }).getByText(/^Maintainer$/i)).toBeVisible({
    timeout: 8_000,
  })
})

test("team attach project adds project to team project list", async ({ alice }) => {
  // Create a project to attach.
  const dash = new Dashboard(alice)
  await dash.goto()
  const projName = `AttachProj ${Date.now()}`
  await dash.createProject({ name: projName })

  // Navigate to teams and create a new team.
  await alice.goto(orgRoute(alice, "/teams"))
  const createBtn = alice.getByRole("button", { name: /\+ New team|Create team|New team/i })
  await expect(createBtn).toBeVisible({ timeout: 30_000 })
  await createBtn.click()

  const teamName = `AttachTeam ${Date.now()}`
  const nameInput = alice.locator('input[placeholder*="name"], input[type="text"]').first()
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /Save|Create|Confirm/i }).first().click()

  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: teamName })).toBeVisible({ timeout: 5_000 })

  // Projects live on the Projects tab (Linear-style team page).
  await alice.getByRole("tab", { name: /^Projects$/i }).click()

  // Click "Attach project".
  const attachLink = alice.getByRole("button", { name: /Attach project/i })
    .or(alice.getByText(/Attach project/i).first())
  await expect(attachLink).toBeVisible({ timeout: 5_000 })
  await attachLink.click()

  // Project select appears — pick our project.
  const projectSelect = alice.getByRole("combobox", { name: "Project to attach" })
  await expect(projectSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, projectSelect, projName)

  // Click "Attach".
  const attachBtn = alice.getByRole("button", { name: /^Attach$/i })
  await expect(attachBtn).toBeVisible({ timeout: 3_000 })
  await attachBtn.click()

  // Project appears in the team's projects table. The attached row uniquely
  // carries an "Actions for <name>" trigger (three-dot menu).
  await expect(
    alice.getByRole("button", { name: `Actions for ${projName}` }),
  ).toBeVisible({ timeout: 8_000 })
})

test("team detach project removes project from team", async ({ alice }) => {
  // Create a project to attach and then detach.
  const dash = new Dashboard(alice)
  await dash.goto()
  const projName = `DetachProj ${Date.now()}`
  await dash.createProject({ name: projName })

  // Navigate to teams and create a new team.
  await alice.goto(orgRoute(alice, "/teams"))
  const createBtn = alice.getByRole("button", { name: /\+ New team|Create team|New team/i })
  await expect(createBtn).toBeVisible({ timeout: 30_000 })
  await createBtn.click()

  const teamName = `DetachTeam ${Date.now()}`
  const nameInput = alice.locator('input[placeholder*="name"], input[type="text"]').first()
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /Save|Create|Confirm/i }).first().click()

  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: teamName })).toBeVisible({ timeout: 5_000 })

  // Projects live on the Projects tab (Linear-style team page).
  await alice.getByRole("tab", { name: /^Projects$/i }).click()

  // Attach project via "Attach project" link.
  const attachLink = alice.getByRole("button", { name: /Attach project/i })
    .or(alice.getByText(/Attach project/i))
    .first()
  await expect(attachLink).toBeVisible({ timeout: 10_000 })
  await attachLink.click()

  // Select the project from the dropdown.
  const projectSelect = alice.getByRole("combobox", { name: "Project to attach" })
  await expect(projectSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, projectSelect, projName)

  // Click "Attach".
  const attachBtn = alice.getByRole("button", { name: /^Attach$/i })
  await expect(attachBtn).toBeVisible({ timeout: 3_000 })
  await attachBtn.click()

  // The project should appear in the team's projects table.
  const actionsBtn = alice.getByRole("button", { name: `Actions for ${projName}` })
  await expect(actionsBtn).toBeVisible({ timeout: 10_000 })

  // Open the row menu and detach.
  await actionsBtn.click()
  const detachItem = alice.getByRole("menuitem", { name: `Detach ${projName}` })
  await expect(detachItem).toBeVisible({ timeout: 3_000 })
  await detachItem.click()

  // The project should no longer appear in the list.
  await expect(actionsBtn).not.toBeVisible({ timeout: 5_000 })
})

test("team rename saves new name on team detail page", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/teams"))
  const newTeamBtn = alice.getByRole("button", { name: /New team/i })
  await expect(newTeamBtn).toBeVisible({ timeout: 10_000 })
  await newTeamBtn.click()

  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const originalName = `RenameTeam ${Date.now()}`
  await nameInput.fill(originalName)
  await alice.getByRole("button", { name: /^Create$/i }).click()

  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  await expect(alice.locator("h1").filter({ hasText: originalName })).toBeVisible({
    timeout: 5_000,
  })

  await alice.getByRole("link", { name: /Team settings/i }).click()
  await alice.waitForURL(/\/teams\/\d+\/settings$/, { timeout: 10_000 })

  const editInput = alice.getByLabel(/^Team name$/i)
  await expect(editInput).toBeVisible({ timeout: 3_000 })
  await expect(editInput).toHaveValue(originalName)

  const newTeamName = `${originalName} — renamed`
  await editInput.fill(newTeamName)
  const saveResponse = alice.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/groups\/\d+/.test(response.url()) &&
      response.ok(),
    { timeout: 10_000 },
  )
  await editInput.blur()
  await saveResponse
  await expect(editInput).toHaveValue(newTeamName)

  // Back to team detail via breadcrumb / settings parent.
  await alice.getByRole("link", { name: newTeamName }).first().click()
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  await expect(alice.locator("h1").filter({ hasText: newTeamName })).toBeVisible({
    timeout: 5_000,
  })
})

test("team edit saves description on team detail page", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/teams"))
  const newTeamBtn = alice.getByRole("button", { name: /New team/i })
  await expect(newTeamBtn).toBeVisible({ timeout: 10_000 })
  await newTeamBtn.click()

  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const teamName = `DescTeam ${Date.now()}`
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /^Create$/i }).click()

  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })

  await alice.getByRole("link", { name: /Team settings/i }).click()
  await alice.waitForURL(/\/teams\/\d+\/settings$/, { timeout: 10_000 })

  const descInput = alice.getByLabel(/^Description$/i)
  await expect(descInput).toBeVisible({ timeout: 3_000 })

  const description = "A team for testing descriptions"
  await descInput.fill(description)
  const saveResponse = alice.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/groups\/\d+/.test(response.url()) &&
      response.ok(),
    { timeout: 10_000 },
  )
  await descInput.blur()
  await saveResponse
  await expect(descInput).toHaveValue(description)

  await alice.getByRole("link", { name: teamName }).first().click()
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  await expect(alice.getByText(description)).toBeVisible({ timeout: 5_000 })
})

test("team delete confirm workflow navigates back to teams list", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/teams"))
  await alice.getByRole("button", { name: /New team/i }).click()
  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(`DeleteTeam ${Date.now()}`)
  await alice.getByRole("button", { name: /^Create$/i }).click()
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })

  await alice.getByRole("link", { name: /Team settings/i }).click()
  await alice.waitForURL(/\/teams\/\d+\/settings$/, { timeout: 10_000 })
  await expect(alice.locator("h1").filter({ hasText: /Team settings/i })).toBeVisible({
    timeout: 5_000,
  })

  const deleteTeamBtn = alice.getByRole("button", { name: /Delete team/i })
  await expect(deleteTeamBtn).toBeVisible({ timeout: 5_000 })
  await deleteTeamBtn.click()

  await expect(
    alice.getByText(/This removes the team and all its grants/i),
  ).toBeVisible({ timeout: 3_000 })

  const cancelBtn = alice.getByRole("button", { name: /^Cancel$/i }).first()
  await expect(cancelBtn).toBeVisible()
  await cancelBtn.click()
  await expect(
    alice.getByText(/This removes the team and all its grants/i),
  ).not.toBeVisible({ timeout: 2_000 })

  await deleteTeamBtn.click()
  const confirmBtn = alice.getByRole("button", { name: /^Confirm$/i })
  await expect(confirmBtn).toBeVisible({ timeout: 3_000 })
  await confirmBtn.click()

  await alice.waitForURL(/\/teams$/, { timeout: 10_000 })
})

test("teams list filter and sort controls work", async ({ alice }) => {
  // Create a team so the search/sort controls appear.
  await alice.goto(orgRoute(alice, "/teams"))
  const createBtn = alice.getByRole("button", { name: /New team|Create team/i })
  await expect(createBtn).toBeVisible({ timeout: 30_000 })
  await createBtn.click()

  const teamName = `SortFilter ${Date.now()}`
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  const nameInput = dialog.getByLabel(/^Team name$/i)
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await dialog.getByRole("button", { name: /^Create$/i }).click()

  // Creating a team navigates straight to its detail page (/teams/:id);
  // return to the list where the search/sort controls live.
  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })
  await alice.goto(orgRoute(alice, "/teams"))
  // Team appears in the list.
  await expect(alice.getByText(teamName)).toBeVisible({ timeout: 8_000 })

  // Search filter input appears.
  const searchInput = alice.getByPlaceholder("Search teams…")
  await expect(searchInput).toBeVisible({ timeout: 5_000 })

  // Type a non-matching query.
  await searchInput.fill("zzznomatch")
  await expect(alice.getByText(/No teams match/i)).toBeVisible({ timeout: 3_000 })

  // Clear the query — team reappears.
  await searchInput.fill("")
  await expect(alice.getByText(teamName)).toBeVisible({ timeout: 3_000 })

  // Sort by Members via the column header (unsorted → descending).
  const membersHeader = alice.getByRole("button", { name: /^Members$/i })
  await expect(membersHeader).toBeVisible({ timeout: 3_000 })
  await membersHeader.click()
  await expect(membersHeader).toHaveAttribute("aria-sort", "descending")
})
