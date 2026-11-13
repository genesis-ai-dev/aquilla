import { createHmac } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { BillingSettingsPage } from "../../helpers/page-objects/BillingSettings"
import { test, expect } from "../../helpers/multi-user"

/**
 * Admin console → Platform → Billing.
 *
 * Does not complete Stripe Checkout or mutate a live catalog. It asserts a
 * platform admin can open the Billing sub-tab and see the Field Plan catalog
 * plus the org metering table.
 */
test("admin platform billing shows Field Plan catalog", async ({ alice }) => {
  await alice.goto("/admin")
  await expect(
    alice.getByText(/Orgs|Users|Active projects/i).first(),
  ).toBeVisible({ timeout: 10_000 })

  await alice.getByRole("tab", { name: /^Platform$/i }).click()
  await alice.getByRole("tab", { name: /^Billing$/i }).click()
  await expect(alice.getByTestId("admin-billing")).toBeVisible({
    timeout: 10_000,
  })
  await expect(
    alice.getByRole("heading", { name: /Plan catalog/i }),
  ).toBeVisible()
  await expect(alice.getByTestId("save-field-plan")).toBeVisible()
  await expect(alice.getByTestId("admin-billing-orgs")).toBeVisible()
})

test("admin weekly capacity persists and reaches the owning organization billing view", async ({
  alice,
}) => {
  const billing = new BillingSettingsPage(alice)
  await billing.setWeeklyAllowance(alice.orgId, 1000)
  await alice.reload()
  // The tab, sub-tab and search live in the URL, so the reload reopens this row.
  await expect(alice.getByLabel("Search name, owner or org id…")).toHaveValue(
    String(alice.orgId),
  )
  await expect(
    alice.getByTestId(`weekly-allowance-${alice.orgId}`),
  ).toHaveValue("1000")
  await billing.openWorkspace(alice.orgId)
  await expect(alice.getByTestId("ai-meter")).toContainText("0%")
  await expect(alice.getByTestId("billing-workspace")).toContainText(
    "covered access",
  )
})

test("admin authenticator enrollment keeps email until activation and supports recovery removal", async ({
  alice,
}) => {
  // Independent Node implementation: don't import Worker-only types into the SPA build.
  const totp = async (secret: string, step: number) => {
    const bits = [...secret].map(c => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("")
    const key = Buffer.from(bits.match(/.{8}/g)!.map(b => parseInt(b, 2)))
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(step))
    const digest = createHmac("sha1", key).update(counter).digest()
    return String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).padStart(6, "0")
  }
  await alice.goto("/admin?tab=platform&platform=security")
  await alice
    .getByRole("button", { name: "Verify and set up authenticator" })
    .click()
  const oldMail = new Set(
    await readdir("auth-worker/.wrangler/tmp/email", { recursive: true }).catch(
      () => [],
    ),
  )
  await alice.getByRole("button", { name: "Email me a code" }).click()
  // Miniflare captures email locally; exercise the real delivery path.
  let emailCode = ""
  await expect
    .poll(async () => {
      const files = await readdir("auth-worker/.wrangler/tmp/email", {
        recursive: true,
      })
      for (const file of files.filter(
        (f) =>
          !oldMail.has(f) && f.includes("email-text/") && f.endsWith(".txt"),
      )) {
        const text = await readFile(
          `auth-worker/.wrangler/tmp/email/${file}`,
          "utf8",
        )
        const match = text.match(/\b\d{6}\b/)
        if (match) emailCode = match[0]
      }
      return emailCode
    })
    .not.toBe("")
  await alice.getByLabel("Verification code", { exact: true }).fill(emailCode)
  const seed = alice.locator("section.ph-no-capture code")
  await expect(seed).toBeVisible()
  await alice
    .getByLabel("Authenticator code", { exact: true })
    .fill(
      await totp((await seed.textContent())!, Math.floor(Date.now() / 30000)),
    )
  await alice.getByRole("button", { name: "Confirm authenticator" }).click()
  const recovery = alice.locator("section.ph-no-capture pre")
  await expect(recovery).toBeVisible()
  const recoveryCodes = (await recovery.textContent())!.split("\n")
  const recoveryCode = recoveryCodes[0]
  await expect(
    alice.getByRole("button", { name: "Enable authenticator app" }),
  ).toBeDisabled()
  await alice.getByLabel("I have saved my recovery codes").check()
  await alice.getByRole("button", { name: "Enable authenticator app" }).click()
  // Activation invalidates the email elevation, even on the local dev stack.
  await expect(alice.getByRole("heading", { name: "Admin verification required" })).toBeVisible()
  await expect(alice.getByRole("button", { name: "Email me a code" })).toHaveCount(0)
  await alice.getByRole("button", { name: "Use a recovery code" }).click()
  await alice.getByLabel("Recovery code", { exact: true }).fill(recoveryCode)
  await alice.getByRole("button", { name: "Verify recovery code" }).click()
  await expect(alice.getByText("Authenticator app is on", { exact: true })).toBeVisible()
  await expect(alice.getByLabel("Authenticator code", { exact: true })).toHaveCount(0)
  await alice.getByRole("button", { name: "Turn off authenticator app", exact: true }).click()
  await expect(alice.getByRole("alert")).toContainText("Make sure you can receive email")
  await expect(alice.locator('[data-slot="input-otp-slot"]')).toHaveCount(6)
  await alice.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(alice.getByText("Authenticator app is on", { exact: true })).toBeVisible()
  await alice.getByRole("button", { name: "Turn off authenticator app", exact: true }).click()
  await alice.getByRole("button", { name: "Use a recovery code" }).click()
  await alice.getByLabel("Recovery code", { exact: true }).fill(recoveryCodes[1])
  await alice.getByRole("button", { name: "Turn off and use email codes" }).click()
  await expect(
    alice.getByRole("button", { name: "Verify and set up authenticator" }),
  ).toBeVisible()
})
