import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"

test("glossary imports CSV and TBX files through the toolbar", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `TermImport ${Date.now()}`, source: "en", target: "fr" })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  const fileInput = alice.locator('input[type="file"][accept=".csv,.tbx"]')

  await fileInput.setInputFiles({
    name: "terms.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("sourceTerm,rendering,status,notes\nmercy,miséricorde,preferred,Theological context"),
  })
  await expect(glossary.row("mercy")).toBeVisible({ timeout: 8_000 })

  await fileInput.setInputFiles({
    name: "terms.tbx",
    mimeType: "application/xml",
    buffer: Buffer.from(`<?xml version="1.0"?><martif><text><body><termEntry id="faith"><langSet xml:lang="source"><tig><term>faith</term></tig></langSet><langSet xml:lang="target"><tig><term>foi</term><termNote type="administrativeStatus">preferredTerm-admn-sts</termNote></tig></langSet></termEntry></body></text></martif>`),
  })
  await expect(glossary.row("faith")).toBeVisible({ timeout: 8_000 })
})
