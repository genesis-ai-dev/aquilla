import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("expanded glossary rendering changes required, alternate, and forbidden status", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `TermRenderStatus ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("grace", "grâce")
  const row = await glossary.expandTerm("grace")
  const status = row.getByRole("combobox", { name: "Rendering 1 status" })
  await expectSelectValue(status, "required")
  await pickSelectOption(alice, status, "alternate")
  await expectSelectValue(status, "alternate")
  await pickSelectOption(alice, status, "forbidden")
  await expectSelectValue(status, "forbidden")
})
