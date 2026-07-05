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
 *  2. Selecting it focuses an unfinished cell's editor (the jump target is
 *     the only cell that mounts a .ProseMirror).
 *  3. Selecting it AGAIN advances to a DIFFERENT cell. This is the
 *     regression pin for getCurrentIndex: when it resolved from the viewport
 *     (or was stubbed to 0), repeat jumps re-found the same first unfinished
 *     cell forever — the "current position" must survive the editor blur
 *     that opening the menu itself causes.
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

  // 2. Selecting it focuses an unfinished cell's editor. Only the active
  //    cell mounts TipTap, so :has(.ProseMirror) identifies the jump target.
  await jumpItem.click()
  const activeCell = alice.locator("[data-cell-id]:has(.ProseMirror)")
  await expect(activeCell).toBeVisible({ timeout: 5_000 })
  const firstTargetId = await activeCell.getAttribute("data-cell-id")
  expect(firstTargetId).toBeTruthy()

  // 3. Jumping again advances to a different cell — repeat clicks must not
  //    bounce back to the same unfinished cell (the original stub bug).
  await ws.jumpNextUnfinished()
  await expect(activeCell).toBeVisible({ timeout: 5_000 })
  await expect
    .poll(async () => activeCell.getAttribute("data-cell-id"), { timeout: 5_000 })
    .not.toBe(firstTargetId)
})
