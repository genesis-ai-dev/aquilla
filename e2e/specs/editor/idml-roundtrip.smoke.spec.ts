import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { readFile, writeFile } from "node:fs/promises"
import JSZip from "jszip"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'
const STORY_PATH = "Stories/Story_u100.xml"

async function writeIdmlFixture(filePath: string): Promise<void> {
  const zip = new JSZip()
  zip.file("mimetype", IDML_MIME, { compression: "STORE", createFolders: false })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?><Document ${IDPKG}><idPkg:Story src="${STORY_PATH}"/></Document>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    "Resources/Styles.xml",
    `<?xml version="1.0"?><idPkg:Styles ${IDPKG}></idPkg:Styles>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    STORY_PATH,
    [
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
      `<idPkg:Story ${IDPKG}><Story Self="u100">`,
      '<ParagraphStyleRange Self="heading" AppliedParagraphStyle="ParagraphStyle/Heading">',
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>Chapter One</Content></CharacterStyleRange>',
      "</ParagraphStyleRange>",
      '<ParagraphStyleRange Self="mixed" AppliedParagraphStyle="ParagraphStyle/Body">',
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>the </Content></CharacterStyleRange>',
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold"><Content>LORD</Content></CharacterStyleRange>',
      "</ParagraphStyleRange>",
      "</Story></idPkg:Story>",
    ].join(""),
    { compression: "DEFLATE", createFolders: false },
  )
  await writeFile(filePath, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  }))
}

test("IDML import, protected edit, and strict artifact export preserve original style runs", async ({
  alice,
}, testInfo) => {
  const fixture = testInfo.outputPath("protected-roundtrip.idml")
  await writeIdmlFixture(fixture)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `IDML round-trip ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(fixture)
  await ws.openFileBySubstring("protected-roundtrip")
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText("Chapter One")

  await ws.editCell(0, "Chapitre Un")
  await ws.openExportDialog()

  const dialog = alice.getByRole("dialog")
  await expect(
    dialog.getByText(/your file in its original format/i),
  ).toBeVisible()
  const [download] = await Promise.all([
    alice.waitForEvent("download", { timeout: 30_000 }),
    dialog.getByRole("button", { name: /^Download protected-roundtrip\.idml$/i }).click(),
  ])
  expect(download.suggestedFilename()).toBe("protected-roundtrip.idml")

  const downloadedPath = await download.path()
  expect(downloadedPath).not.toBeNull()
  const output = await JSZip.loadAsync(await readFile(downloadedPath!))
  const story = await output.file(STORY_PATH)!.async("string")

  expect(story).toContain(
    'AppliedCharacterStyle="CharacterStyle/Plain"><Content>Chapitre Un</Content>',
  )
  expect(story).toContain(
    'AppliedCharacterStyle="CharacterStyle/Plain"><Content>the </Content>',
  )
  expect(story).toContain(
    'AppliedCharacterStyle="CharacterStyle/Bold"><Content>LORD</Content>',
  )
  await expect(dialog.getByText(/1 paragraph translated/i)).toBeVisible()
})
