import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("glossary renders toolbar and opens add-term dialog", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Glossary ${Date.now()}` })

  await new Glossary(alice).goto(seeded.projectId)
  await expect(alice.getByText("Source", { exact: true })).toBeVisible()
  await expect(alice.getByText("Rendering", { exact: true })).toBeVisible()

  const addBtn = alice.getByRole("button", { name: "Add term" })
  await expect(addBtn).toBeVisible()
  await expect(addBtn).toBeEnabled()
  await addBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByPlaceholder("New source term…")).toBeVisible()
  await expect(dialog.getByPlaceholder("rendering", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Add term" })).toBeDisabled()
})
