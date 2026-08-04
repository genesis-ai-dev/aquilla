import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { readFile, writeFile } from "node:fs/promises"
import JSZip from "jszip"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'
const UTILITY_STORY_PATH = "Stories/Story_running_header.xml"
const STORY_PATH = "Stories/Story_u100.xml"
const TALL_SOURCE = [
  "Chapter One.",
  "This deliberately long source paragraph makes the opposite empty target well taller than one line. ".repeat(12),
].join(" ")

async function writeIdmlFixture(
  filePath: string,
  headingStyle = "ParagraphStyle/Heading",
  headingText = TALL_SOURCE,
): Promise<void> {
  const zip = new JSZip()
  zip.file("mimetype", IDML_MIME, { compression: "STORE", createFolders: false })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?><Document ${IDPKG}><idPkg:Story src="${UTILITY_STORY_PATH}"/><idPkg:Story src="${STORY_PATH}"/></Document>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    "Resources/Styles.xml",
    `<?xml version="1.0"?><idPkg:Styles ${IDPKG}></idPkg:Styles>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    UTILITY_STORY_PATH,
    `<?xml version="1.0" encoding="UTF-8"?><idPkg:Story ${IDPKG}><Story Self="running-header"><ParagraphStyleRange Self="running-header-tab"><CharacterStyleRange><Content>	<?ACE 18?><?ACE 8?></Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    STORY_PATH,
    [
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
      `<idPkg:Story ${IDPKG}><Story Self="u100">`,
      `<ParagraphStyleRange Self="heading" AppliedParagraphStyle="${headingStyle}">`,
      `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>${headingText}</Content></CharacterStyleRange>`,
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
  await expect(ws.cellRow(1)).toContainText("the LORD")
  await expect(alice.locator('[data-paragraph-start="true"]')).toHaveCount(0)

  const navigator = alice.getByRole("combobox", {
    name: /Current story: Story 1, cells 1–2/,
  })
  await expect(navigator).toContainText("(1–2)")
  await navigator.click()
  await expect(alice.getByRole("option", { name: /1–2 0% translated 0% validated/ }))
    .toBeVisible()
  await alice.keyboard.press("Escape")

  // AQU-758 sanitizes whitespace at entry: the deliberately doubled space
  // typed before "Un" collapses to a single space in the committed cell.
  await ws.editIdmlCellFromBlankArea(0, "Chapitre", "  Un", "Chapitre Un")
  // The first click on a populated cell happens on the cheap read surface.
  // Preserve its exact slot offset across the ProseMirror remount (offset 9
  // is the boundary before "U"), then insert at that clicked position.
  await ws.editIdmlCellAtTextOffset(0, 9, "X", "Chapitre XUn")
  // Re-enter the populated IDML target through its read view. The activation
  // fallback must append at the real ProseMirror slot end, not jump to the
  // beginning as the browser-recorded AQU-740 regression did.
  await ws.editCell(0, " — suite")
  await expect(ws.cellRow(0)).toContainText("Chapitre XUn — suite")
  await expect(
    alice.getByText(/This edit would remove protected InDesign formatting/i),
  ).toHaveCount(0)

  // A lossless re-import can advance the source event for IDML structure while
  // retaining exactly the same translatable source text. That must preserve
  // the target without raising the source-changed warning (AQU-741).
  await writeIdmlFixture(fixture, "ParagraphStyle/HeadingReimported")
  await ws.reimportFile(fixture)
  await alice.reload()
  await ws.openFileBySubstring("protected-roundtrip")
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText("Chapitre XUn — suite")
  await expect(alice.getByTestId("stale-source-indicator")).toHaveCount(0)
  await expect(
    alice.getByText(/Source text changed since your last edit/i),
  ).toHaveCount(0)

  // IDML cell locators are file-local and can repeat across packages. A
  // different file with the same story/paragraph locator must not make this
  // file's translated row look stale (AQU-741 cross-file collision).
  const collidingFixture = testInfo.outputPath("other-package.idml")
  await writeIdmlFixture(
    collidingFixture,
    "ParagraphStyle/Heading",
    "Completely different source at the same IDML locator.",
  )
  await ws.importFile(collidingFixture)
  await ws.openFileBySubstring("protected-roundtrip")
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText("Chapitre XUn — suite")
  await expect(alice.getByTestId("stale-source-indicator")).toHaveCount(0)

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
    'AppliedCharacterStyle="CharacterStyle/Plain"><Content>Chapitre XUn — suite</Content>',
  )
  expect(story).toContain(
    'AppliedCharacterStyle="CharacterStyle/Plain"><Content>the </Content>',
  )
  expect(story).toContain(
    'AppliedCharacterStyle="CharacterStyle/Bold"><Content>LORD</Content>',
  )
  await expect(dialog.getByText(/1 paragraph translated/i)).toBeVisible()
})
