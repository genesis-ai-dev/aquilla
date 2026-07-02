import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Next-unfinished navigation action.
 *
 * `useNextUnfinished` scans cells for any that are unfinished (no translated
 * text, or fewer than validationCount validators). FRO-331 moved the action
 * from a toolbar button into the workspace header "More" overflow menu as the
 * "Next unfinished" menu item; it is disabled when there is no active file or
 * no unfinished cell. Selecting it scrolls the list to the next
 * unfinished cell after the current position (Cmd+. is the shortcut).
 *
 * This spec verifies:
 *  1. After importing a file (all cells start unfinished), the menu item is
 *     enabled (no aria-disabled).
 *  2. Selecting it does not crash the UI (editor remains stable).
 *
 * The sample.md fixture has multiple cells, so we only check that the action
 * is enabled and remains interactive — exhausting all cells in a virtualised
 * list would be unwieldy in a smoke spec.
 */
test("next-unfinished menu item is enabled when unfinished cells exist and jumps without crashing", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `NextUnfinished ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the header ⋯ overflow menu — "Next unfinished" lives there (FRO-331).
  await ws.openHeaderOverflowMenu()
  const jumpItem = alice.getByRole("menuitem", { name: /Next unfinished/i })
  await expect(jumpItem).toBeVisible({ timeout: 5_000 })

  // 1. With freshly-imported cells (none translated), the item is enabled.
  await expect(jumpItem).not.toHaveAttribute("aria-disabled", "true")

  // 2. Selecting it doesn't crash — editor cells still render after the jump.
  await jumpItem.click()
  await expect(alice.locator("[data-cell-id]").first()).toBeVisible({ timeout: 5_000 })
})
