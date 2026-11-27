import { expect } from "@playwright/test"
import { openMediaView, uploadSampleRecordings } from "../../tutorials/setup"
import { tutorial } from "../../tutorials/tutorial"

tutorial("volume-and-fades", async (t) => {
  const { page, show } = t
  const take = page.getByRole("button", { name: /^Take Play this clip/ }).first()

  await t.say("intro")

  await show.point(take)
  await take.click({ button: "right" })
  const edit = page.getByRole("menuitem", { name: /Edit in the Station/ })
  await show.click(edit)
  await show.click(page.getByTestId("dock-full-lr"))
  await t.say("open")

  const lane = page.getByTestId("station-lane")
  const laneBox = (await lane.boundingBox())!
  await show.point({ x: laneBox.x + laneBox.width * 0.5, y: laneBox.y + laneBox.height * 0.5 })
  await page.mouse.move(laneBox.x + laneBox.width * 0.5, laneBox.y + laneBox.height * 0.5)
  const readout = page.getByTestId("station-volume")
  await expect(readout).toBeVisible()

  // Volume: drag the line up a little.
  const line = page.getByTestId("station-volume-line")
  const lb = (await line.boundingBox())!
  const lx = laneBox.x + laneBox.width * 0.4
  await page.mouse.move(lx, lb.y + lb.height / 2, { steps: 8 })
  await page.mouse.down()
  await page.mouse.move(lx, lb.y + lb.height / 2 - laneBox.height * 0.12, { steps: 20 })
  await page.mouse.up()
  await expect(readout).not.toHaveText("0 dB")
  await t.say("volume")

  // Fades: the knob at the top-left corner, dragged inward.
  const knob = page.getByTestId("station-fade-in")
  const kb = (await knob.boundingBox())!
  await show.point(knob)
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2)
  await page.mouse.down()
  await page.mouse.move(kb.x + laneBox.width * 0.15, kb.y + kb.height / 2, { steps: 20 })
  await page.mouse.up()
  await expect(knob).toHaveAccessibleName(/\d/)
  await t.say("fade")

  const outKnob = page.getByTestId("station-fade-out")
  const ob = (await outKnob.boundingBox())!
  await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2, { steps: 10 })
  await page.mouse.down()
  await page.mouse.move(ob.x - laneBox.width * 0.12, ob.y + ob.height / 2, { steps: 20 })
  await page.mouse.up()
  await page.mouse.move(laneBox.x + laneBox.width * 0.5, laneBox.y + laneBox.height * 0.7, { steps: 8 })
  await t.say("tint")
  await t.say("outro")
}, {
  setup: async (page) => {
    await uploadSampleRecordings(page)
    await openMediaView(page)
  },
})
