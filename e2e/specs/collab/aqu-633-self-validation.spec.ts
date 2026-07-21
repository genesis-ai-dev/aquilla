import { test, expect } from "../../helpers/multi-user"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { bootstrapSharedProject, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { v4 as uuid } from "uuid"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * AQU-633 (part C fix) — the rose "reason" banner surfaces a validate 403.
 *
 * With allowSelfValidation=false, a contributor validating a cell they
 * translated gets a server 403 ("self-validation is not allowed on this
 * project"). The client does NOT gate self-validation, so the event reaches the
 * server and is quarantined. BEFORE the fix this silently reverted behind a
 * bare "N failed" pill; AFTER the fix, the onForbidden flush callback surfaces
 * the reason in the rose banner (forbidden-copy.ts). This spec verifies both the
 * wire-level 403 and that the banner now explains WHY.
 */
test("AQU-633: a self-validate 403 surfaces the reason banner (not a silent revert)", async ({
  alice,
  bob,
}) => {
  // ── 1. Alice creates a shared project and adds bob as CONTRIBUTOR(400) ──────
  const aliceSession = await ensureAuthState("alice")
  const projectId = uuid()
  const name = `AQU633 ${Date.now()}`
  await bootstrapSharedProject(aliceSession.jwt, {
    id: projectId,
    name,
    collaboratorUsername: "bob",
    collaboratorRole: ROLE.CONTRIBUTOR,
  })

  // Alice imports the file (skip the "Set translation direction" gate for
  // server-created projects, per the cross-user-validate spec).
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")
  await alice.evaluate(
    (id) => localStorage.setItem(`codex.importDirectionSkipped.${id}`, "true"),
    projectId,
  )
  const aliceWs = new Workspace(alice)
  await aliceWs.importFile(SAMPLE_MD)
  await aliceWs.openFileBySubstring("sample")
  await aliceWs.waitForEditor()

  // ── 2. Bob (contributor) translates cell 0 → bob is the cell's last_editor ──
  await bob.goto(`/project/${projectId}`)
  await bob.waitForLoadState("networkidle")
  const bobWs = new Workspace(bob)
  await bobWs.openFileBySubstring("sample")
  await bobWs.waitForEditor()
  await bobWs.editCell(0, "Bob's translation of cell zero")
  await bob.waitForTimeout(1_500) // let target commit + any auto-validate settle

  // A human edit auto-validates while allowSelfValidation is still TRUE — undo
  // it so the explicit validate below is a genuine (re)validate hitting the server.
  const bobToggle = bobWs.validationToggle(0)
  await bobWs.cellRow(0).hover()
  if ((await bobToggle.getAttribute("aria-pressed").catch(() => null)) === "true") {
    await bobWs.unvalidateCell(0)
  }

  // ── 3. Alice (owner) turns OFF allow-self-validation and saves ──────────────
  await alice.goto(`/project/${projectId}/settings?section=validation`)
  await alice.waitForLoadState("networkidle")
  // Base UI Switch: #allow-self-validation is the hidden <input>; the visible,
  // clickable control is the sibling role="switch" carrying aria-checked.
  const selfSwitch = alice.getByRole("switch").first()
  await expect(selfSwitch).toBeVisible({ timeout: 10_000 })
  if ((await selfSwitch.getAttribute("aria-checked")) === "true") {
    await selfSwitch.click()
  }
  await expect(selfSwitch).toHaveAttribute("aria-checked", "false")

  const savePatch = alice.waitForResponse(
    (r) =>
      /\/api\/v2\/projects\/[^/]+\/settings/.test(r.url()) &&
      (r.request().method() === "PATCH" || r.request().method() === "PUT"),
    { timeout: 15_000 },
  )
  await alice.getByRole("button", { name: /Save changes/i }).click()
  const patchResp = await savePatch
  expect(patchResp.status(), "settings PATCH should persist").toBeLessThan(300)

  // ── 4. Bob explicitly validates his own cell → expect server 403 ────────────
  await bobWs.cellRow(0).hover()
  await expect(bobToggle).toBeVisible({ timeout: 10_000 })

  const validateResp = bob.waitForResponse(
    (r) =>
      r.url().includes("/events") &&
      r.request().method() === "POST" &&
      (r.request().postData()?.includes("cell.validate") ?? false),
    { timeout: 20_000 },
  )
  await bobToggle.focus()
  await bob.keyboard.press("Space")

  const resp = await validateResp
  const body = await resp.json()
  console.log(`[AQU-633] explicit validate → POST /events ${resp.status()}:`, JSON.stringify(body))

  // Wire-level: the server rejected the self-validate with the expected reason.
  expect(body.rejected?.length ?? 0, "server should reject the self-validate").toBeGreaterThan(0)
  expect(body.rejected[0].status).toBe(403)
  expect(body.rejected[0].reason).toMatch(/self-validation is not allowed/i)

  // ── 5. The cell does NOT stay validated (flip-then-revert) ──────────────────
  await bobWs.cellRow(0).hover()
  await expect(bobToggle).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 })

  // ── 6. THE FIX (C): the rose banner surfaces the reason, not a silent revert ─
  const banner = bob.getByText(/wasn't saved|weren't saved/i)
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await expect(banner).toContainText(/validate a cell you translated/i)
})
