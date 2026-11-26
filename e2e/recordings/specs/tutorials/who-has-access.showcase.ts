import { expect } from "@playwright/test"
import { DEMO_ORG, startOn } from "../../tutorials/setup"
import { tutorial } from "../../tutorials/tutorial"

tutorial("who-has-access", async (t) => {
  const { page, show } = t
  await t.say("intro")

  const matrix = page.getByRole("tab", { name: "Matrix" }).or(page.getByText("Matrix", { exact: true })).first()
  await show.point(matrix)
  await t.say("open")
  await show.click(matrix)
  const grid = page.getByText("amara.okafor").first()
  await expect(grid).toBeVisible()
  await show.point(page.getByText("John — Plainspeak Draft").first())
  await t.say("grid")

  const empty = page.getByRole("row", { name: /tomas\.reyes/ }).getByText("—").last()
  await show.click(empty)
  await t.say("add")
  await page.keyboard.press("Escape")

  const legend = page.getByText("Access model legend")
  await show.click(legend)
  await t.say("legend")
}, { setup: startOn(`${DEMO_ORG}/members`, (page) => page.getByText("Matrix", { exact: true }).first().waitFor()) })
