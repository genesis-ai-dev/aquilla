import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * TranslatedEditor — Tab / Shift+Tab cell navigation.
 *
 * TranslatedEditor.tsx registers a TipTap keydown extension:
 *   Tab → navigate("next") — moves focus to the next target cell
 *   Shift+Tab → navigate("prev") — moves focus to the previous target cell
 *   ArrowDown (at last visual line) → navigate("next")
 *   ArrowUp (at first visual line) → navigate("prev")
 *
 * This spec:
 *   1. Imports sample.md (has ≥3 cells).
 *   2. Clicks into the first target cell's editor to focus it. (NOT via
 *      Workspace.editCell(), which deliberately clicks the sidebar afterwards
 *      to blur-commit — leaving nothing focused.)
 *   3. Presses Tab → verifies the SECOND cell's editor is focused
 *      (EditorTable.handleNavigateCell → focusCellEditorByIndex).
 *   4. Presses Shift+Tab → verifies focus returns to the first cell.
 */
test("Tab moves focus to the next target cell; Shift+Tab returns to previous", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `TabNav ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Click directly into the first target cell's TipTap editor to focus it.
  // (Workspace.editCell() is unsuitable here: it clicks the sidebar after
  // typing to blur-commit, so nothing would be focused afterwards.)
  const firstEditor = await ws.activateTargetCell(0)
  const secondEditor = ws.cellRow(1).locator('.ProseMirror[contenteditable="true"]').first()
  await expect(firstEditor).toBeFocused({ timeout: 5_000 })

  // Press Tab — TranslatedEditor's handleKeyDown calls navigate("next"),
  // which focuses the next cell's ProseMirror (focusCellEditorByIndex).
  await alice.keyboard.press("Tab")
  await expect(secondEditor).toBeFocused({ timeout: 5_000 })

  // Press Shift+Tab — should navigate back to the previous (first) cell.
  await alice.keyboard.press("Shift+Tab")
  const reactivatedFirstEditor = ws.cellRow(0).locator('.ProseMirror[contenteditable="true"]').first()
  await expect(reactivatedFirstEditor).toBeFocused({ timeout: 5_000 })
})
