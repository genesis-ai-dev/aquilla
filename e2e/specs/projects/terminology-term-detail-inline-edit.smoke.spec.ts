import { test, expect } from "../../helpers/multi-user"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

test("term detail occurrence opens an inline target editor", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `TermDetailEdit ${Date.now()}` })
  const projectId = seeded.projectId

  const glossary = new Glossary(alice)
  await glossary.goto(projectId)
  await glossary.addTerm("sample", "échantillon")
  await glossary.openDetails("sample")
  await expect(alice.getByText(/occurrence/i).first()).toBeVisible({ timeout: 15_000 })

  const editableTarget = alice.getByRole("button", { name: "(empty)" }).first()
  await expect(editableTarget).toBeVisible({ timeout: 5_000 })
  await editableTarget.click()
  const editor = alice.locator('[contenteditable="true"], textarea').first()
  await expect(editor).toBeVisible({ timeout: 5_000 })
  await editor.click()
  await alice.keyboard.type("Traduction test")
  await expect(editor).toContainText("Traduction test")
})
