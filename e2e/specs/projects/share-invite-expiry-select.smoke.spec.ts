import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

/**
 * InviteLinkTab — "Link expires" select changes value.
 *
 * Options: "1 day", "7 days (default)", "30 days", "No expiry".
 */
test("share invite expiry select changes value", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ShareExp ${Date.now()}` })
  const settings = new ProjectSettings(alice)
  const dialog = await settings.openInviteLinkTab(seeded.projectId)

  const expirySelect = dialog.getByRole("combobox", { name: "Link expires" })
  await expect(expirySelect).toBeVisible({ timeout: 3_000 })

  await expectSelectValue(expirySelect, "7 days (default)")

  await pickSelectOption(alice, expirySelect, "No expiry")
  await expectSelectValue(expirySelect, "No expiry")

  await pickSelectOption(alice, expirySelect, "1 day")
  await expectSelectValue(expirySelect, "1 day")
})
