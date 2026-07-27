import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { bootstrapSharedProject } from "../../helpers/frontier-api"
import { v4 as uuid } from "uuid"

test("member presence popover is fully visible above workspace chrome", async ({ alice, bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const projectId = uuid()
  await bootstrapSharedProject(aliceSession.jwt, {
    id: projectId,
    name: `Presence ${Date.now()}`,
    collaboratorUsername: "bob",
  })

  await Promise.all([
    alice.goto(`/project/${projectId}/editor`),
    bob.goto(`/project/${projectId}/editor`),
  ])

  const presenceTrigger = alice.getByRole("button", { name: /bob/i }).first()
  await expect(presenceTrigger).toBeVisible()
  await presenceTrigger.click()

  // The popover no longer repeats the count as a visible title (the trigger
  // already carries it); its accessible name is the stable hook.
  const popover = alice.getByLabel("1 online")
  await expect(popover).toBeVisible()
  await expect(popover.getByRole("button", { name: /bob online/i })).toBeVisible()

  const isUnobscured = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const points = [
      [rect.left + 4, rect.top + rect.height / 2],
      [rect.right - 4, rect.top + rect.height / 2],
    ]

    return points.every(([x, y]) => {
      const topmost = document.elementFromPoint(x, y)
      return topmost === element || (topmost !== null && element.contains(topmost))
    })
  })
  expect(isUnobscured).toBe(true)

  await alice.keyboard.press("Escape")
  await expect(popover).toBeHidden()
})
