import { test, expect } from "@playwright/test"
import {
  prepareEdit, prepareValidation, authenticatedPage, editorUrl, targetSurface, validationButton,
} from "../fixture"
import { observeDom } from "../dom"

test("DOM audit: project surfaces and editor activation use Jev's actual snapshot", async ({ browser }, testInfo) => {
  const fixture = await prepareEdit()
  const { seeded, session, contract } = fixture
  const { page, context } = await authenticatedPage(browser, session, seeded)
  const reports: Awaited<ReturnType<typeof observeDom>>[] = []
  try {
    for (const route of [
      "/app", `/projects/${seeded.projectId}`,
      editorUrl(seeded), `/project/${seeded.projectId}/settings`,
      `/project/${seeded.projectId}/comments`,
      `/project/${seeded.projectId}/memory`,
      `/project/${seeded.projectId}/memory/instructions`,
      `/project/${seeded.projectId}/memory/quality`,
    ]) {
      await page.goto(route)
      await expect(page.getByText(seeded.projectName, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('[data-testid="cell-area-loading"]')).toHaveCount(0)
      await expect(page.getByText("Something went wrong", { exact: true })).toHaveCount(0)
      reports.push(await observeDom(page))
    }
    await page.goto(editorUrl(seeded))
    const surface = targetSurface(page, contract.cellId)
    const activation = surface.getByRole("button")
    await expect(activation).toBeVisible({ timeout: 30_000 })
    const label = await activation.getAttribute("aria-label")
    expect(label).toContain("Translation for row 1: Welcome to the translation project.")
    const before = await observeDom(page)
    // This entry point must exist before hover/focus. The first comment
    // journey exposed an otherwise invisible action rail.
    expect(before.actions.some((action) => action.kind === "click"
      && action.label === `More actions · ${label}`)).toBe(true)
    expect(before.actions.some((action) => action.kind === "click" && action.label === label)).toBe(true)
    expect(before.actions.some((action) => action.kind === "fill" && action.label === label)).toBe(false)
    await activation.press("Space")
    await expect(surface.locator('[contenteditable="true"]')).toBeFocused({ timeout: 30_000 })
    const after = await observeDom(page)
    expect(after.actions.some((action) => action.kind === "fill" && action.label === label)).toBe(true)
    reports.push(before, after)
  } finally {
    await testInfo.attach("dom-audit", {
      body: JSON.stringify({
        scope: "Initial viewport on eight seeded project surfaces, plus editor activation. Not every dialog or interaction method.",
        reports,
      }, null, 2),
      contentType: "application/json",
    })
    await context.close()
  }
})

test("DOM audit: the validation control is a named entry point on a translated row", async ({ browser }, testInfo) => {
  const fixture = await prepareValidation()
  const { seeded, session, contract } = fixture
  const { page, context } = await authenticatedPage(browser, session, seeded)
  try {
    await page.goto(editorUrl(seeded))
    const control = validationButton(page, contract.cellId)
    await expect(control).toBeVisible({ timeout: 30_000 })
    const label = await control.getAttribute("aria-label")
    // The sign-off journey cannot start unless this control reaches Jev's
    // snapshot without hover, and its name says which row it approves.
    expect(label).toContain("Not validated")
    expect(label).toContain("row 3")
    const report = await observeDom(page)
    expect(report.actions.some((action) => action.kind === "click" && action.label === label)).toBe(true)
    // A per-row name is what stops an agent approving whichever row is first.
    expect(report.actions.filter((action) => action.kind === "click"
      && action.label?.startsWith("Not validated")).length).toBe(seeded.cellIds.length)
    await testInfo.attach("dom-audit", {
      body: JSON.stringify({
        scope: "The editor's validation gutter on a fully translated seeded file.",
        label, reports: [report],
      }, null, 2),
      contentType: "application/json",
    })
  } finally {
    await context.close()
  }
})
