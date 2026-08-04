import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"

const TRANSLATION_TITLE = "E2E Tiny Bible"
const TRANSLATIONS_URL =
  "https://raw.githubusercontent.com/BibleNLP/ebible/main/metadata/translations.csv"
const CORPUS_URL =
  "https://raw.githubusercontent.com/BibleNLP/ebible/main/corpus/eng-e2e.txt"

const CSV_HEADER =
  "languageCode,translationId,languageName,languageNameInEnglish,dialect,homeDomain,title,description,Redistributable,Copyright,UpdateDate,publicationURL,OTbooks,OTchapters,OTverses,NTbooks,NTchapters,NTverses,DCbooks,DCchapters,DCverses,FCBHID,Certified,inScript,swordName,rodCode,textDirection,downloadable,font,shortTitle,PODISBN,script,sourceDate"

const CSV_ROW = [
  "eng",
  "e2e",
  "English",
  "English",
  "",
  "example.test",
  TRANSLATION_TITLE,
  "Small deterministic browser fixture",
  "True",
  "Public domain",
  "2026-07-31",
  "",
  "1",
  "1",
  "3",
  "0",
  "0",
  "0",
  "0",
  "0",
  "0",
  "",
  "",
  "",
  "",
  "",
  "ltr",
  "True",
  "",
  "E2E",
  "",
  "Latin",
  "2026-07-31",
].join(",")

test("an imported eBible file remains in the project after reload", async ({ alice }) => {
  await alice.route(TRANSLATIONS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/csv",
      body: `${CSV_HEADER}\n${CSV_ROW}\n`,
    }),
  )
  await alice.route(CORPUS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "In the beginning.\nThe earth was formless.\nLet there be light.\n",
    }),
  )

  const dashboard = new Dashboard(alice)
  await dashboard.goto()
  const projectName = `EBible persistence ${Date.now()}`
  await dashboard.createProject({ name: projectName, source: "en", target: "fr" })
  await dashboard.openProject(projectName)

  const workspace = new Workspace(alice)
  await workspace.importEBibleCorpus(TRANSLATION_TITLE)
  await workspace.waitForFileInSidebar(TRANSLATION_TITLE)

  await alice.reload()
  await workspace.waitForFileInSidebar(TRANSLATION_TITLE)
  await workspace.openFileBySubstring(TRANSLATION_TITLE)
  await workspace.waitForEditor()
  await expect(workspace.cellRow(0)).toContainText("In the beginning.")
})
