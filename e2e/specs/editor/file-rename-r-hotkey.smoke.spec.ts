import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * FileRow.tsx — "r" key triggers inline rename.
 *
 * When a FileRow element has keyboard focus (tabIndex=0) and the user
 * presses "r" (without Cmd/Ctrl), onStartRename() is called, opening
 * the same inline rename input as the right-click context menu's Rename
 * option.
 *
 * Guard: `if (editing) return` — only fires when NOT already in rename mode.
 *
 * This is distinct from the right-click rename path tested in
 * file-rename.smoke.spec.ts and file-rename-escape-cancel.smoke.spec.ts.
 */
test('"r" key on focused file row opens inline rename input', async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `RHotkey ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Focus the file row via click (gives keyboard focus).
  const sidebar = alice.locator("aside")
  const fileRow = sidebar.getByText("sample").first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })

  // Click to select the file (which also focuses the row element).
  await fileRow.click()

  // The FileRow root is a div with tabIndex=0 — focus it and press "r".
  const rowDiv = sidebar
    .locator('div[tabindex="0"]')
    .filter({ hasText: "sample" })
    .first()
  await rowDiv.focus()
  await rowDiv.press("r")

  // Inline rename input should appear. The sidebar's filter input is a
  // role=searchbox (and also input[type=text]), so role=textbox uniquely
  // matches the rename input.
  const inlineInput = sidebar.getByRole("textbox")
  await expect(inlineInput).toBeVisible({ timeout: 3_000 })

  // The input should have the current filename pre-filled.
  await expect(inlineInput).toHaveValue(/sample/i)

  // Press Escape to cancel (clean up).
  await inlineInput.press("Escape")
  await expect(inlineInput).not.toBeVisible({ timeout: 2_000 })
})
