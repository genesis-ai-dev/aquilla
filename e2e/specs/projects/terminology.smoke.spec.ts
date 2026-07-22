import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("glossary renders its editor-style append surface", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Glossary ${Date.now()}` })

  await new Glossary(alice).goto(seeded.projectId)
  await expect(alice.getByText("Source", { exact: true })).toBeVisible()
  await expect(alice.getByText("Rendering", { exact: true })).toBeVisible()
  await expect(alice.getByPlaceholder("New source term…")).toBeVisible()
  await expect(alice.getByPlaceholder("rendering", { exact: true })).toBeVisible()
  await expect(alice.getByRole("button", { name: "Add term" })).toBeDisabled()
})
