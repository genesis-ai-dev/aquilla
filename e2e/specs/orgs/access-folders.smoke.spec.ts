import type { Locator, Page } from "@playwright/test"
import { test, expect, orgRoute } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, createProjectServerSide, getMyOrg, ROLE } from "../../helpers/frontier-api"
import { createGroup } from "../../helpers/frontier-api-groups"

/**
 * Folders on People & access (AQU-2778). Teams are folders in the one access
 * tree now; the Teams list and team page are gone, and these are the journeys
 * they used to guard: make a folder, give a person access at it, change and
 * remove that access, and put a project in it. Each one reloads, because the
 * tree is redrawn from the server and an optimistic row would pass without
 * anything having been stored.
 *
 * Not a surface session: the mutations conflict across steps, so every test
 * keeps its own hermetic reset.
 */

function folderRow(page: Page, groupId: number): Locator {
  return page.getByTestId(`access-node-team-${groupId}`)
}

/** The people added at a row. The list opens on hover. */
async function openPeople(page: Page, row: Locator): Promise<Locator> {
  await row.getByTestId("folder-people").hover()
  const list = page.getByTestId("folder-people-list")
  await expect(list).toBeVisible()
  return list
}

test("a folder made on People & access is still there after a reload", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/access"))
  const tree = alice.getByTestId("access-folder-tree")
  await expect(tree).toBeVisible({ timeout: 15_000 })

  // The "+" on the organization row offers a folder or a project.
  const orgRow = tree.locator('[data-testid^="access-node-org-"]')
  await orgRow.hover()
  await orgRow.getByTestId("folder-new").click()
  await alice.getByTestId("folder-new-team").click()

  const name = `E2E Folder ${Date.now()}`
  const naming = alice.getByTestId("new-folder-row")
  await naming.getByLabel("Folder name").fill(name)
  await naming.getByTestId("new-folder-create").click()
  await expect(naming).toHaveCount(0)

  const created = tree.locator('[data-testid^="access-node-team-"]', { hasText: name })
  await expect(created).toBeVisible()

  await alice.reload()
  await expect(created).toBeVisible({ timeout: 15_000 })
})

test("a person is added to a folder, has their role changed, and is removed", async ({ alice }) => {
  const session = await ensureAuthState("alice")
  const acme = await getMyOrg(session.jwt)
  await addOrgMember(session.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)
  const folder = await createGroup(session.jwt, acme.id, `People folder ${Date.now()}`)

  await alice.goto(orgRoute(alice, "/access"))
  const row = folderRow(alice, folder.id)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.getByTestId("folder-people")).toContainText("No one added")

  // Add bob at the folder.
  await row.getByTestId("folder-add-person").click()
  const adding = alice.getByRole("dialog").filter({ hasText: "Add people to" })
  await adding.getByRole("combobox", { name: "Search people or type an email" }).fill("bob")
  await adding.getByRole("option", { name: /bob/i }).first().click()
  await expect(adding.getByTestId("add-person-chosen")).toContainText(/bob/i)
  // A folder takes Maintainer, Project Lead or Viewer.
  await adding.getByRole("radio", { name: /^Viewer/ }).click()
  await adding.getByTestId("add-person-submit").click()
  await expect(adding).toBeHidden()

  await alice.reload()
  await expect(row).toBeVisible({ timeout: 15_000 })
  let people = await openPeople(alice, row)
  const bob = people.getByTestId("direct-person").filter({ hasText: /bob/i })
  await expect(bob).toHaveCount(1)
  await expect(bob.getByTestId("role-dropdown")).toContainText(/Viewer/i)

  // Change the role from the list.
  await bob.getByTestId("role-dropdown").click()
  await alice.locator(`[data-testid="role-option"][data-role-level="${ROLE.MAINTAINER}"]`).click()
  await expect(bob.getByTestId("role-dropdown")).toContainText(/Maintainer/i)

  await alice.reload()
  await expect(row).toBeVisible({ timeout: 15_000 })
  people = await openPeople(alice, row)
  await expect(people.getByTestId("direct-person").filter({ hasText: /bob/i }).getByTestId("role-dropdown"))
    .toContainText(/Maintainer/i)

  // Remove bob from the folder.
  await people.getByTestId("direct-person").filter({ hasText: /bob/i }).getByTestId("remove-grant").click()
  const confirm = alice.getByTestId("remove-access-dialog")
  await expect(confirm).toBeVisible()
  await confirm.getByTestId("remove-access-confirm").click()
  await expect(confirm).toBeHidden()

  await alice.reload()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.getByTestId("folder-people")).toContainText("No one added")
})

test("a project is moved into a folder and back out of it", async ({ alice }) => {
  const session = await ensureAuthState("alice")
  const acme = await getMyOrg(session.jwt)
  const folder = await createGroup(session.jwt, acme.id, `Project folder ${Date.now()}`)
  const project = await createProjectServerSide(session.jwt, {
    id: `e2e-folder-move-${Date.now()}`,
    name: `Movable ${Date.now()}`,
    orgId: acme.id,
  })

  await alice.goto(orgRoute(alice, "/access"))
  const tree = alice.getByTestId("access-folder-tree")
  const projectRow = alice.getByTestId(`access-node-project-${project.id}`)
  await expect(projectRow).toBeVisible({ timeout: 15_000 })
  // A row's children are the group inside its tree item.
  const insideFolder = tree
    .locator('li[role="treeitem"]', { has: folderRow(alice, folder.id) })
    .last()
    .getByTestId(`access-node-project-${project.id}`)
  await expect(insideFolder).toHaveCount(0)

  await projectRow.hover()
  await projectRow.getByTestId("folder-move").click()
  await alice.getByTestId(`move-to-${folder.id}`).click()
  await expect(insideFolder).toBeVisible()

  await alice.reload()
  await expect(insideFolder).toBeVisible({ timeout: 15_000 })

  await projectRow.hover()
  await projectRow.getByTestId("folder-move").click()
  await alice.getByTestId("move-to-org").click()
  await expect(insideFolder).toHaveCount(0)
  await expect(projectRow).toBeVisible()

  await alice.reload()
  await expect(projectRow).toBeVisible({ timeout: 15_000 })
  await expect(insideFolder).toHaveCount(0)
})
