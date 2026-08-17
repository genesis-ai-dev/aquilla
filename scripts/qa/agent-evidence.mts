// AQU-AGENT QA evidence capture (W2-QA).
// Drives the seeded dev stack through the agent golden path (no LLM required)
// and saves screenshots to docs/swarm/aqu-agent-qa/. Run AFTER `pnpm dev` is up:
//   pnpm tsx scripts/qa/agent-evidence.mts
import { chromium, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import path from "node:path"

const AUTH = "http://127.0.0.1:8788"
const SYNC = "http://127.0.0.1:8789"
const WEB = "http://127.0.0.1:5173"
const PROJECT = "dev-project"
const OUT = path.resolve("docs/swarm/aqu-agent-qa")
const FIXTURE = path.resolve("e2e/fixtures/agent/mixed-notes.csv")

async function j(method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, name), fullPage: false })
  console.log("saved", name)
}

async function main() {
  // 1. login (mints JWT + seeds dev user/org/project)
  const login = await j("POST", `${AUTH}/__dev__/login`, {}, {})
  const jwt = login.json.access_token as string
  const bearer = { authorization: `Bearer ${jwt}` }

  // 2. seed a fresh agent-proposed memory (agent channel) for the proposed-queue shot
  const run = `qa-evidence-${Date.now()}`
  await j("POST", `${AUTH}/api/v2/projects/${PROJECT}/agent-memory`, { ...bearer, "x-aquilla-agent-run": run }, {
    path: "observations/evidence-note.md",
    content: "# Evidence note\nThe agent proposed this during QA evidence capture.",
    rationale: "captured for QA evidence",
    provenance: { runId: run },
  })
  // brief proposal (agent channel) for the brief-review shot
  await j("POST", `${AUTH}/api/v2/projects/${PROJECT}/brief/proposals`, { ...bearer, "x-aquilla-agent-run": run }, {
    content: "Working brief: formal register, prefer Amharic Ge'ez script for source display.",
    rationale: "captured for QA evidence",
  })

  // 3. stage a PlanImport changeset via an ask-mode credential for the approval-page shot
  const cred = await j("POST", `${AUTH}/api/v2/credentials`, bearer, { name: `qa-evidence-${Date.now()}`, mode: "ask", projectId: PROJECT })
  const token = cred.json.token as string
  const stage = await j("POST", `${SYNC}/api/v1/external/projects/${PROJECT}/changesets`, { authorization: `Bearer ${token}` }, {
    autonomyMode: "ask",
    commands: [{
      kind: "PlanImport", fileName: "evidence-import.csv", fileType: "csv", sourceLanguage: "en", targetLanguage: "am",
      cells: [
        { id: "a", content: "Evidence cell one." },
        { id: "b", content: "Evidence cell two." },
      ],
    }],
  })
  const changesetId = stage.json.changeset.id as string

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  // Inject the dev session into IDB, mirroring e2e/helpers/auth.ts.
  await page.goto(WEB + "/", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)
  await page.evaluate(async (s) => {
    await new Promise<void>((res, rej) => {
      const open = indexedDB.open("frontier", 1)
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains("session")) open.result.createObjectStore("session") }
      open.onsuccess = () => { const db = open.result; const tx = db.transaction("session", "readwrite"); tx.objectStore("session").put({ active: s.username, sessions: { [s.username]: s } }, "envelope"); tx.oncomplete = () => { db.close(); res() }; tx.onerror = () => rej(tx.error) }
      open.onerror = () => rej(open.error)
    })
    localStorage.setItem("codex:onboardingComplete", "true")
    localStorage.setItem("codex:productTourDone", "1")
    document.cookie = "aq_hint=1; Path=/; Max-Age=31536000; SameSite=Lax"
  }, { jwt, username: "dev", createdAt: new Date().toISOString() })

  const agentUrl = `${WEB}/project/${PROJECT}/agent`

  // ── Item 1: workbench loads ──
  await page.goto(agentUrl)
  await page.getByRole("tab", { name: "Chat" }).waitFor({ timeout: 15000 })
  await page.waitForTimeout(800)
  await shot(page, "01-agent-workbench.png")

  // ── Item 2: memory proposed → approve → edit → human-edited badge ──
  await page.getByRole("tab", { name: "Project knowledge" }).click()
  await page.getByRole("tab", { name: "Proposed" }).click()
  await page.locator('[data-memory-path="observations/evidence-note.md"]').first().waitFor({ timeout: 10000 })
  await shot(page, "02-memory-proposed.png")

  const propRow = page.locator('[data-memory-path="observations/evidence-note.md"]').first()
  await propRow.getByRole("button", { name: "Approve", exact: true }).click()
  await page.waitForTimeout(600)
  await page.getByRole("tab", { name: "Approved" }).click()
  await page.locator('[data-memory-path="observations/evidence-note.md"]').first().waitFor({ timeout: 10000 })
  await shot(page, "03-memory-approved.png")

  const apprRow = page.locator('[data-memory-path="observations/evidence-note.md"]').first()
  await apprRow.getByRole("button", { name: /Edit/i }).click()
  const editor = page.getByRole("textbox", { name: /memory content/i })
  await editor.fill("# Evidence note\nHuman reviewer edited this content during QA.")
  await page.getByRole("button", { name: /^Save$/ }).click()
  await page.waitForTimeout(800)
  // reload to pick up the (non-auto-revalidated) human-edited state
  await page.goto(agentUrl)
  await page.getByRole("tab", { name: "Project knowledge" }).click()
  await page.getByRole("tab", { name: "Approved" }).click()
  await page.getByText(/Human.?edited/i).first().waitFor({ timeout: 10000 })
  await shot(page, "04-memory-human-edited-badge.png")

  // brief proposal review
  await page.getByRole("tab", { name: "Project brief" }).click()
  await page.waitForTimeout(800)
  await shot(page, "05-brief-proposal.png")

  // ── Item 3: artifact attach → pill ──
  await page.goto(agentUrl)
  await page.getByRole("tab", { name: "Chat" }).waitFor({ timeout: 15000 })
  await page.waitForTimeout(600)
  await page.locator('input[type="file"]').first().setInputFiles(FIXTURE)
  try {
    await page.locator("[data-attachment-id]").first().waitFor({ timeout: 30000 })
    await shot(page, "06-artifact-pill.png")
    console.log("artifact pill: OK")
  } catch (e) {
    await shot(page, "06-artifact-pill-FAILED.png")
    console.log("artifact pill: NOT FOUND", String(e))
  }

  // ── Item 5: mock-LLM streaming run ──
  const composer = page.getByRole("textbox", { name: "Ask the agent" })
  await composer.click()
  await composer.fill("show me the current status of the open file")
  await page.getByRole("button", { name: "Send" }).click()
  // wait for a tool-activity row and the budget meter
  await page.getByText(/current state|read/i).first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(1500)
  await shot(page, "07-run-timeline.png")

  // ── Item 4: changeset approval page ──
  await page.goto(`${WEB}/approve/${changesetId}`)
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor({ timeout: 10000 })
  await shot(page, "08-approve-page.png")
  await page.getByRole("button", { name: "Approve", exact: true }).click()
  await page.getByText(/Approved/i).first().waitFor({ timeout: 10000 })
  await shot(page, "09-approve-confirmed.png")
  // commit via external API to prove the write lands
  const commit = await j("POST", `${SYNC}/api/v1/external/projects/${PROJECT}/changesets/${changesetId}/commit`, { authorization: `Bearer ${token}` }, {})
  console.log("commit status", commit.status, "appliedCount", commit.json?.receipt?.appliedCount)

  await browser.close()
  console.log("DONE — evidence in", OUT)
}

main().catch((e) => { console.error(e); process.exit(1) })
