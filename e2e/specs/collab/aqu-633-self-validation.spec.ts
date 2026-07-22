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
 * With allowSelfValidation=false, editing must not auto-validate the
 * contributor's own work. If they then explicitly try to validate that work,
 * the server returns a 403 ("self-validation is not allowed on this project")
 * and the client quarantines the event. BEFORE the fix this silently reverted
 * behind a bare "N failed" pill; AFTER the fix, the records-derived banner
 * explains WHY. This spec verifies the auto-validation gate, wire-level 403,
 * reverted UI state, and explanatory banner.
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
  await alice.evaluate(
    (id) => localStorage.setItem(`codex.importDirectionSkipped.${id}`, "true"),
    projectId,
  )
  const aliceWs = new Workspace(alice)
  await aliceWs.importFile(SAMPLE_MD)
  await aliceWs.openFileBySubstring("sample")
  await aliceWs.waitForEditor()
  const fileId = alice.url().match(/\/file\/([^/?#]+)/)?.[1]
  expect(fileId, "imported file id should be present in the editor URL").toBeTruthy()

  // ── 2. Alice (owner) turns OFF allow-self-validation and saves ──────────────
  await alice.goto(`/project/${projectId}/settings?section=validation`)
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

  // ── 3. Bob edits while self-validation is disabled ─────────────────────────
  // Navigate directly to the imported file and let Workspace's editor and
  // target-commit response waits provide the readiness boundaries. This avoids
  // `networkidle` and elapsed-time guesses on slower machines.
  await bob.goto(`/project/${projectId}/file/${fileId}`)
  const bobWs = new Workspace(bob)
  await bobWs.waitForEditor()
  await bobWs.editCell(0, "Bob's translation of cell zero")

  // The edit itself must remain unvalidated. The focused unit test covers the
  // negative emit decision; this assertion verifies the corresponding UI state.
  const bobToggle = bobWs.validationToggle(0)
  await bobWs.cellRow(0).hover()
  await expect(bobToggle).toHaveAttribute("aria-pressed", "false")

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
