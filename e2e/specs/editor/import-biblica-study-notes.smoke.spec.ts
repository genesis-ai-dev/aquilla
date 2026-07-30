import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { writeFile } from "node:fs/promises"
import JSZip from "jszip"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'
const STORY_PATH = "Stories/Story_biblica.xml"

const PREFACE_NOTE = "Genesis introduces the story of beginnings."
const CHAPTER_ONE_NOTE = "God alone creates the heavens and the earth."
const SCRIPTURE = "In the beginning God created the heavens and the earth."
/** One InDesign paragraph, its items separated by line breaks. */
const REFERENCE_LIST = [
  "Creation: Genesis 1:1-2:25.",
  "Covenant: Genesis 12:1-9.",
] as const
/** One InDesign paragraph holding several sentences of commentary. */
const NOTE_BLOCK_SENTENCES = [
  "1:1-2:3 The account of creation is told as a week of work. ",
  "Each day is introduced by the same formula and closed by an evening refrain.",
] as const
const NOTE_BLOCK = NOTE_BLOCK_SENTENCES.join("")

const PLAIN = "$ID/[No character style]"

function run(characterStyle: string, text: string): string {
  return `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${characterStyle}">`
    + `<Content>${text}</Content></CharacterStyleRange>`
}

function paragraph(self: string, paragraphStyle: string, inner: string): string {
  return `<ParagraphStyleRange Self="${self}" AppliedParagraphStyle="ParagraphStyle/${paragraphStyle}">`
    + inner
    + `</ParagraphStyleRange>`
}

/**
 * A Biblica study-Bible page: a `meta:bk` book marker, an `intro:*` note before
 * any scripture, one fully marked-up verse, a note about that chapter, a
 * reference list set as a single line-broken paragraph, and a multi-sentence
 * note block.
 */
async function writeBiblicaFixture(filePath: string): Promise<void> {
  const zip = new JSZip()
  zip.file("mimetype", IDML_MIME, { compression: "STORE", createFolders: false })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?><Document ${IDPKG}><idPkg:Story src="${STORY_PATH}"/></Document>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    STORY_PATH,
    [
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
      `<idPkg:Story ${IDPKG}><Story Self="u200">`,
      paragraph("p-bk", "meta%3abk", run(PLAIN, "GEN")),
      paragraph("p-pref", "intro%3aip", run(PLAIN, PREFACE_NOTE)),
      paragraph(
        "p-v1",
        "cv%3ap",
        run("cv%3adc", "1")
          + run("cv%3av1", "1")
          + run("meta%3av", "1")
          + run(PLAIN, SCRIPTURE)
          + run("meta%3av", "1"),
      ),
      paragraph("p-n1", "intro%3aipi", run(PLAIN, CHAPTER_ONE_NOTE)),
      paragraph(
        "p-list",
        "intro%3aili1",
        `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${PLAIN}">`
          + REFERENCE_LIST.map((line) => `<Content>${line}</Content>`).join("<Br/>")
          + `</CharacterStyleRange>`,
      ),
      paragraph("p-n2", "intro%3aip", run(PLAIN, NOTE_BLOCK)),
      "</Story></idPkg:Story>",
    ].join(""),
    { compression: "DEFLATE", createFolders: false },
  )
  await writeFile(filePath, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  }))
}

test("Biblica study Bible import brings in the notes and leaves the scripture out", async ({
  alice,
}, testInfo) => {
  const fixture = testInfo.outputPath("genesis-notes.idml")
  await writeBiblicaFixture(fixture)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Biblica notes ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importViaSpecializedPanel(/Biblica Study Bible Notes/i, fixture, async (dialog) => {
    // Sentence split is opt-out; the default keeps note blocks one cell per sentence.
    await expect(dialog.getByRole("checkbox", {
      name: /Split long notes into one cell per sentence/i,
    })).toBeChecked()
  })

  // The importer drops the "-notes" suffix, so the file reads as its book.
  await ws.openFileBySubstring("genesis")
  await ws.waitForEditor()

  const rows = alice.locator("[data-cell-id]")
  await expect(rows).toHaveCount(6, { timeout: 15_000 })
  await expect(ws.cellRow(0)).toContainText(PREFACE_NOTE)
  await expect(ws.cellRow(1)).toContainText(CHAPTER_ONE_NOTE)

  // The reference list is one InDesign paragraph, but a translator works a line
  // at a time, so each line arrives as its own cell.
  await expect(ws.cellRow(2)).toContainText(REFERENCE_LIST[0])
  await expect(ws.cellRow(2)).not.toContainText(REFERENCE_LIST[1])
  await expect(ws.cellRow(3)).toContainText(REFERENCE_LIST[1])

  // With the split option on (default), a note block arrives as one cell per
  // sentence; export merges the sentences back into that paragraph.
  await expect(ws.cellRow(4)).toContainText(NOTE_BLOCK_SENTENCES[0].trim())
  await expect(ws.cellRow(4)).not.toContainText(NOTE_BLOCK_SENTENCES[1])
  await expect(ws.cellRow(5)).toContainText(NOTE_BLOCK_SENTENCES[1])

  // The whole point of this importer: the Bible text is not imported for
  // translation, even though it was present in the package.
  await expect(alice.getByText(SCRIPTURE)).toHaveCount(0)

  // Notes stay editable as normal target cells.
  await ws.editCell(0, "La Genèse raconte les commencements.")
  await expect(ws.cellRow(0)).toContainText("La Genèse raconte les commencements.")
})
