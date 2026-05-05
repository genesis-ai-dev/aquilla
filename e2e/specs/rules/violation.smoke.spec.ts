import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Verify built-in rule enable + violation surfacing.
 *
 * The "double-space" check has display name "Extra whitespace" (per
 * src/lib/lqa/builtin-registry.ts). The rules page uses an `aria-label`
 * of `${def.name} enabled` for each toggle. A cell with violations
 * renders an indicator dot with `aria-label` matching `/\d+ issue/`
 * (per EditorTable.tsx).
 */
// TODO(e2e): regressed between 5a808b4 and now. The cell ends up with text
// "this has double spaces" (single spaces) instead of the typed "this  has
// double  spaces" — keyboard.type() into the cell editor (textarea or
// ProseMirror) collapses consecutive spaces somewhere, so the "Extra
// whitespace" rule has nothing to flag and no issue indicator appears.
// Likely fix: use editor.fill() / setInputFiles-style writes, or type via a
// fixture that bypasses ProseMirror normalization. Re-enable once the
// edit path preserves whitespace.
test.fixme("alice enables 'Extra whitespace' rule and sees a violation surfaced in editor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Rules ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // Enable the built-in rule on the rules page.
  await alice.goto(`/project/${projectId}/rules`)
  const toggle = alice.getByRole("checkbox", { name: /Extra whitespace enabled/i })
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  if (!(await toggle.isChecked())) {
    await toggle.check()
  }

  // Back to workspace, import, type a violation.
  await alice.goto(`/project/${projectId}`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await ws.editCell(0, "this  has  double  spaces") // intentional doubles

  // The cell should surface an issue indicator (the small colored dot
  // with aria-label "N issue(s) (severity)").
  await expect(
    ws.cellRow(0).locator('[aria-label*="issue"]').first(),
  ).toBeVisible({ timeout: 10_000 })
})
