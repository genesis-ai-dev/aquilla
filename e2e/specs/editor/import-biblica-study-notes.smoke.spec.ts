import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { writeFile } from "node:fs/promises"
import JSZip from "jszip"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'
const STORY_PATH = "Stories/Story_biblica.xml"

const GLOBAL_PREFACE_NOTE = "GEN — General notes prepared for this edition."
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
/** Chapter/verse markers InDesign bled out of the preceding verse (AQU-860). */
const BLED_MARKER_CHAPTER = "28"
const BLED_MARKER_VERSE = "20"

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
 * A Biblica study-Bible page: a document-level note before `meta:bk`, a
 * book-level note before any scripture, one fully marked-up verse, a note about
 * that chapter, a reference list set as a single line-broken paragraph, and a
 * multi-sentence note block.
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
      paragraph("p-global-pref", "intro%3aip", run(PLAIN, GLOBAL_PREFACE_NOTE)),
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
      paragraph(
        "p-n1",
        "intro%3aipi",
        run(PLAIN, "God alone creates ")
          + run("Bold", "the heavens and the earth."),
      ),
      paragraph(
        "p-list",
        "intro%3aili1",
        `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/${PLAIN}">`
          + REFERENCE_LIST.map((line) => `<Content>${line}</Content>`).join("<Br/>")
          + `</CharacterStyleRange>`,
      ),
      paragraph("p-n2", "intro%3aip", run(PLAIN, NOTE_BLOCK)),
      // AQU-860: InDesign flushes a verse's closing markers into the paragraph
      // that follows it, so a note paragraph can hold nothing but the previous
      // book's last chapter:verse. It owns no cell — appended last so every
      // cell above keeps its row index.
      paragraph(
        "p-bleed",
        "intro%3aie",
        run("meta%3ac", `${BLED_MARKER_CHAPTER}:`) + run("meta%3av", BLED_MARKER_VERSE),
      ),
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
    await expect(dialog.getByRole("checkbox", {
      name: /Split long notes into one cell per sentence/i,
    })).not.toBeChecked()
  })

  // The importer drops the "-notes" suffix, so the file reads as its book.
  await ws.openFileBySubstring("genesis")
  await ws.waitForEditor()

  const rows = alice.locator("[data-cell-id]")
  await expect(rows).toHaveCount(6, { timeout: 15_000 })
  await expect(ws.cellRow(0)).toContainText(GLOBAL_PREFACE_NOTE)
  await expect(ws.cellRow(1)).toContainText(PREFACE_NOTE)
  await expect(ws.cellRow(2)).toContainText(CHAPTER_ONE_NOTE)

  // The reference list is one InDesign paragraph, but a translator works a line
  // at a time, so each line arrives as its own cell.
  await expect(ws.cellRow(3)).toContainText(REFERENCE_LIST[0])
  await expect(ws.cellRow(3)).not.toContainText(REFERENCE_LIST[1])
  await expect(ws.cellRow(4)).toContainText(REFERENCE_LIST[1])

  // With sentence splitting off (default), the note block stays one cell.
  await expect(ws.cellRow(5)).toContainText(NOTE_BLOCK_SENTENCES[0].trim())
  await expect(ws.cellRow(5)).toContainText(NOTE_BLOCK_SENTENCES[1])

  // Notes retain Biblica's richer Preface/chapter grouping in the universal
  // navigator while verse paragraphs remain protected source structure.
  await expect(alice.getByRole("combobox", {
    name: /Current chapter: Preface/,
  })).toBeVisible()
  await alice.getByRole("combobox", { name: /Current chapter: Preface/ }).click()
  await expect(alice.getByRole("option", { name: /^Cells 1–1 / }))
    .toHaveAttribute("data-milestone-subsection")
  await alice.keyboard.press("Escape")
  await alice.getByRole("button", { name: "Next chapter" }).click()
  await expect(alice.getByRole("combobox", {
    name: /Current chapter: Genesis Preface/,
  })).toBeVisible()
  await alice.getByRole("button", { name: "Next chapter" }).click()
  await expect(alice.getByRole("combobox", {
    name: /Current chapter: Genesis 1/,
  })).toBeVisible()
  await expect(ws.cellRow(2)).toBeVisible()

  // The whole point of this importer: the Bible text is not imported for
  // translation, even though it was present in the package.
  await expect(alice.getByText(SCRIPTURE)).toHaveCount(0)

  // AQU-860: the bled marker paragraph produced no seventh cell (asserted by
  // the count above) and its fragment reached no cell that does exist.
  await expect(
    alice.getByText(`${BLED_MARKER_CHAPTER}:${BLED_MARKER_VERSE}`, { exact: false }),
  ).toHaveCount(0)

  // AQU-742: reproduce the real replace failure — an existing multi-style
  // target, followed by a model response that keeps every slot identity/text
  // but adds contenteditable="false" to an editable slot. The client must
  // rebuild canonical HTML from those slots and leave the row terminal.
  const llmBase = process.env.VITE_LLM_BASE_URL ?? ""
  expect(llmBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  await alice.evaluate(({ endpoint }) => {
    localStorage.setItem("codex:userProviderOverride", JSON.stringify({
      endpoint,
      model: "mock-model",
      apiKey: "",
    }))
  }, { endpoint: `${llmBase}/v1` })
  await alice.reload()
  await ws.waitForEditor()
  await ws.editCell(2, "Traduction existante.")
  await alice.route("**/v1/chat/completions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    const body = route.request().postDataJSON() as {
      messages?: Array<{ content?: string }>
    }
    const prompt = body.messages?.map((message) => message.content ?? "").join("\n") ?? ""
    const start = prompt.indexOf('<p data-idml-version="2">')
    const end = prompt.indexOf("</p>", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const canonical = prompt.slice(start, end + 4)
    const damaged = canonical.replace(
      'data-idml-protected="slot"',
      'data-idml-protected="slot" contenteditable="false"',
    )
    expect(damaged).not.toBe(canonical)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content: damaged } }],
      }),
    })
  })
  const aiRow = ws.cellRow(2)
  await aiRow.hover()
  const sparkle = aiRow.locator(
    "[data-tooltip*='Translate with AI'] button, button[aria-label*='Translate with AI']",
  ).first()
  await expect(sparkle).toBeVisible()
  await sparkle.click()
  await alice.getByRole("button", { name: /Replace|Overwrite|Continue/i }).click()
  await expect(aiRow.locator('[data-cell-type="target"]'))
    .toContainText(CHAPTER_ONE_NOTE, { timeout: 15_000 })
  await expect(aiRow).not.toHaveAttribute("data-ai-translating", "true")
  await expect(
    alice.getByText(/AI draft changed a protected IDML anchor/i),
  ).toHaveCount(0)

  // Notes stay editable as normal target cells.
  await ws.editCell(0, "Notes générales.")
  await expect(ws.cellRow(0)).toContainText("Notes générales.")
  await expect(
    alice.getByText(/This edit would remove protected InDesign formatting/i),
  ).toHaveCount(0)
})
