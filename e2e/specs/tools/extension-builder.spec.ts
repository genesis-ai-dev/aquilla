// Smart Extensions builder (AQU-1793): a first-time user goes Describe →
// Review & try → Add to project, and the extension shows up where they work.
//
// The model call (POST …/tools/build) is answered with a REAL builder output
// (no builder key in e2e); everything after it is real: the client's lint +
// sandboxed smoke render, the Review & try preview (the extension running in
// the sandbox on sample verses), the install (auth-worker, Postgres), and the
// extension in the editor's palette / side panel and "Edit with".

import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Route } from "@playwright/test"
import { test, expect } from "../../helpers/multi-user"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { FOCUS_EDITOR_SOURCE } from "../../../src/lib/tools/starters/focus-editor-source"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORD_COUNT = path.join(__dirname, "../../fixtures/tools/word-count-built.html")
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const usage = { promptTokens: 9000, completionTokens: 2400, cost: 0.21 }
const BUILD = /\/tools\/build$/

test("describe → watch it build → try it on sample verses → add it → it opens in the side panel", async ({ alice }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Builder ${Date.now()}`, fixturePath: FIXTURE })
  const source = await readFile(WORD_COUNT, "utf8")
  const manifest = { name: "Word Count", description: "Word count per verse and for the file, live.", scopes: ["read:cells"], mounts: ["panel", "page"], apiRev: 5 }
  const requests: string[] = []
  let release: () => void = () => {}
  const held = new Promise<void>((r) => { release = r })
  await alice.route(BUILD, async (route: Route) => {
    requests.push((route.request().postDataJSON() as { request: string }).request)
    await held
    await route.fulfill({ json: { ok: true, source, manifest, model: "anthropic/claude-opus-5.5", usage } })
  })

  const tools = new ToolsPage(alice)
  await tools.open(seeded.projectId)
  const steps = alice.getByTestId("builder-steps")
  await expect(steps.locator("[aria-current=step]")).toContainText("Describe")

  // 1 Describe: plain words + where it should appear.
  const words = "Show the word count of each verse's translation and the total for the file, updating live as I type"
  await alice.getByRole("textbox", { name: "What should it do?" }).fill(words)
  await alice.getByRole("tab", { name: "Side panel" }).click()
  await alice.getByTestId("builder-build").click()

  // Building: the user's words, the real steps, a time expectation, Cancel.
  const progress = alice.getByTestId("tool-build-progress")
  await expect(progress).toContainText(words)
  await expect(progress).toContainText("Usually 30–60 seconds")
  await expect(progress.getByRole("button", { name: "Cancel" })).toBeVisible()
  await expect(steps.locator("[aria-current=step]")).toContainText("Review & try")
  release()

  // 2 Review & try: their words quoted, the extension running on sample verses.
  const review = alice.getByTestId("built-candidate")
  await expect(review).toBeVisible({ timeout: 30_000 })
  expect(requests[0]).toBe(`${words}\n\nIt should appear in the editor's side panel (mount: panel).`)
  await expect(review.getByTestId("candidate-request")).toContainText(`“${words}”`)
  await expect(review).toContainText("Opens in the editor's side panel, beside the verses.")
  await expect(review.getByTestId("scope-summary")).toContainText("Read files and cells")
  const preview = review.getByTestId("extension-preview-frame").contentFrame()
  await expect(preview.locator("body")).toContainText("words", { timeout: 30_000 })

  // 3 Add to project → its page, then the editor's side panel.
  await tools.addCandidate()
  await alice.waitForURL(/\/extensions\/[0-9a-f-]{36}$/)
  await expect(tools.toolFrame("Word Count").locator("body")).toContainText("MAT 1:1", { timeout: 30_000 })

  await alice.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  await new Workspace(alice).waitForEditor()
  await tools.openInSidePanelFromPalette("Word Count")
  const panel = alice.getByTestId("tools-dock-panel").frameLocator('iframe[title="Word Count (sandboxed extension)"]')
  await expect(panel.locator("body")).toContainText("words", { timeout: 30_000 })
})

test("\"Build your own editor…\" builds an editor that appears in \"Edit with\"", async ({ alice }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Builder editor ${Date.now()}`, fixturePath: FIXTURE })
  const manifest = { name: "One Verse Editor", description: "One verse at a time, source on top.", scopes: ["read:cells", "write:target", "write:validation"], mounts: ["editor", "page"], apiRev: 1 }
  const requests: string[] = []
  await alice.route(BUILD, async (route: Route) => {
    requests.push((route.request().postDataJSON() as { request: string }).request)
    await route.fulfill({ json: { ok: true, source: FOCUS_EDITOR_SOURCE, manifest, model: "anthropic/claude-opus-5.5", usage } })
  })
  const tools = new ToolsPage(alice)
  // The product default (the first-party editor extension), so the file view
  // shows "Edit with" and its "Build your own editor…" link.
  await tools.optIntoDefaultEditorExtension()
  await alice.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  await alice.getByTestId("build-own-editor").click()
  await alice.waitForURL(/\/extensions\?where=editor$/)
  await expect(alice.getByRole("tab", { name: "As an editor" })).toHaveAttribute("aria-selected", "true")

  const name = await tools.buildExtension("Show one verse at a time in large text, with the source above it")
  expect(name).toBe("One Verse Editor")
  expect(requests[0]).toMatch(/\(mount: editor\)\.$/)
  const review = alice.getByTestId("built-candidate")
  await expect(review).toContainText("Replaces the editor for a file.")
  await expect(review.getByTestId("scope-summary")).toContainText("Changes")

  await tools.addCandidate()
  await alice.waitForURL(/\/editor/)
  await alice.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  await tools.switchEditor("One Verse Editor")
  await expect(tools.toolFrame("One Verse Editor").getByLabel("Translation")).toBeVisible({ timeout: 30_000 })
})
