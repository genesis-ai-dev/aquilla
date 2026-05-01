import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

// FIXME: The `[data-violation]` attribute used as the violation indicator
// selector may not exist on the live components. Built-in rules UI is also
// being iterated (see 2026-04-21-auto-correct-rule-violations-design.md).
// Need to: (a) confirm the actual rule-toggle UI control name (the
// `getByRole("switch", { name: /double.space/i })` is speculative), and
// (b) find the real violation indicator in EditorTable / ViolationPopover.
test.fixme("alice enables double-space rule and sees a violation surfaced in editor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Rules ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  // Open Rules page (route confirmed: /project/:id/rules → RulesPage)
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]!
  await alice.goto(`/project/${projectId}/rules`)
  // Enable the built-in double-space check
  await alice.getByRole("switch", { name: /double.space/i }).check()

  // Back to workspace, import, type a violation
  await alice.goto(`/project/${projectId}`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await ws.editCell(0, "this  has  double  spaces") // intentional doubles

  // Expect a violation indicator on the row (red ring or violation marker)
  await expect(ws.cellRow(0).locator("[data-violation], .text-red-500").first()).toBeVisible({ timeout: 5_000 })
})
