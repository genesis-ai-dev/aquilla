import { expect } from "@playwright/test"
import { openMediaView, uploadSampleRecordings } from "../../tutorials/setup"
import { tutorial } from "../../tutorials/tutorial"

tutorial("trim-and-cut", async (t) => {
  const { page, show } = t
  const take = page.getByRole("button", { name: /^Take Play this clip/ }).first()

  await t.say("intro")

  await show.point(take)
  await take.click({ button: "right" })
  const edit = page.getByRole("menuitem", { name: /Edit in the Station/ })
  await expect(edit).toBeVisible()
  await show.point(edit)
  await t.say("open")
  await show.click(edit)

  // Give the Station the whole area, so its waveform is big enough to work on.
  await show.click(page.getByTestId("dock-full-lr"))

  const startFlag = page.getByRole("button", { name: /^Drag to trim the start/ })
  const endFlag = page.getByRole("button", { name: /^Drag to trim the end/ })
  await expect(startFlag).toBeVisible()
  const wave = page.getByRole("group", { name: /^Drag across the recording/ })
  const box = (await wave.boundingBox())!

  // Trim: Start in a little, End in a little.
  const drag = async (from: { x: number; y: number }, toX: number) => {
    await show.point(from)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(toX, from.y, { steps: 18 })
    await page.mouse.up()
  }
  const s = (await startFlag.boundingBox())!
  const e = (await endFlag.boundingBox())!
  await drag({ x: s.x + s.width / 2, y: s.y + s.height / 2 }, s.x + s.width / 2 + box.width * 0.08)
  await drag({ x: e.x + e.width / 2, y: e.y + e.height / 2 }, e.x + e.width / 2 - box.width * 0.08)
  await t.say("trim")

  // Cut: select a part in the middle, then Delete this.
  const mid = box.y + box.height * 0.6
  await drag({ x: box.x + box.width * 0.42, y: mid }, box.x + box.width * 0.58)
  const del = page.getByRole("button", { name: /^Delete this/ })
  await expect(del).toBeVisible()
  await show.point(del)
  await t.say("cut")
  await show.click(del)

  const undo = page.getByRole("button", { name: /^Undo (your last change to this recording|the last unsaved change)/ })
  await show.point(undo)
  await t.say("wait")

  const save = page.getByRole("button", { name: /^Save/ }).filter({ visible: true }).first()
  await show.click(save)
  await t.say("save")
}, {
  setup: async (page) => {
    await uploadSampleRecordings(page)
    await openMediaView(page)
  },
})
