// Smart Extensions apiRev 7 — the primitives anything (including an
// unfoldingWord editor) is built from, end to end:
//   1. an IMPORTER extension's settings action runs headless, reads a site
//      (mocked at the browser), and files.upsert creates a tagged, grouped
//      project file attributed to the extension (verified tool session);
//   2. an EDITOR extension finds the file by tag, opens its group and reads a
//      verse across files with cells.byRef;
//   3. a data record anchored to a cell round-trips (data.put / data.get) as
//      "current", lives in a hidden data file (not in the file list), and
//      reads "changed" after the importer's refresh action re-upserts a new
//      note text as a delta;
//   4. the importer's export format appears in the export dialog for the
//      tagged file and downloads what the extension delivers.
//
// Crosses SPA (headless frames, bridge, outbox, export dialog), auth-worker
// (tool store, tool session mint, web-fetch route mocked at the browser) and
// sync-worker (/import with extension identity, events, by-ref, files read)
// over Postgres.

import { test, expect } from "../../helpers/multi-user"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { jwtFor, mintSyncToken, seedProjectWithFile } from "../../helpers/seed-project"

const AUTH = process.env.VITE_AUTH_BASE ?? "http://127.0.0.1:8787"
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`
const SITE = "resources.example.org"
const NOTES_URL = `https://${SITE}/tn_MAT.tsv`
const HEADER = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote"
const tsv = (note: string) => `${HEADER}\n1:1\tq3ab\t\t\tΒίβλος γενέσεως\t1\t${note}\n1:2\tw9cd\t\t\tἈβραὰμ\t1\tAbraham note\n`

const IMPORTER = "E2E Importer"
const IMPORTER_SOURCE = `<!doctype html><html><body><p id="s">Importer</p><script>
(async () => {
  const ctx = aquilla.context
  if (ctx.mount === "action") {
    try {
      const r = await aquilla.web.fetch(${JSON.stringify(NOTES_URL)})
      const lines = String(r.body).split("\\n").filter(Boolean)
      lines.shift()
      const cells = lines.map((l) => { const f = l.split("\\t"); return { key: f[1], value: f[6], ref: "MAT " + f[0], metadata: { Quote: f[4] } } })
      const out = await aquilla.files.upsert({ key: "e2e:tn:MAT", name: "MAT notes (e2e)", kind: "normal", tags: ["e2e", "book:MAT"], group: "e2e:MAT", meta: { size: String(r.body).length }, format: "tsv", cells })
      await aquilla.action.done((out.created ? "created " : "refreshed ") + out.creates + "+" + out.commits)
    } catch (e) { await aquilla.action.done(String(e.message || e), { ok: false }) }
    return
  }
  if (ctx.mount === "export") {
    const cells = await aquilla.cells.list(ctx.export.fileIds[0])
    await aquilla.export.deliver([{ name: "notes.tsv", mime: "text/tab-separated-values", text: "Reference\\tNote\\n" + cells.map((c) => c.ref + "\\t" + c.source).join("\\n") }])
    return
  }
  document.getElementById("s").textContent = "Importer ready"
})()
</script></body></html>`
const IMPORTER_MANIFEST = {
  name: IMPORTER,
  description: "Imports notes as a live-linked file.",
  scopes: ["read:web", "write:files", "read:cells"],
  web: [SITE],
  mounts: ["page"],
  apiRev: 7,
  actions: [{ id: "import", label: "Import notes", where: ["settings", "bar"] }],
  exports: [{ id: "notes-tsv", label: "Notes TSV", extension: "tsv", tags: ["e2e"] }],
}

const EDITOR = "E2E Notes Editor"
const EDITOR_SOURCE = `<!doctype html><html><body>
<button id="load">Load</button><button id="anchor">Anchor</button><button id="check">Check</button><pre id="out">idle</pre>
<script>
let notesFile = null, noteCell = null
const out = (t) => { document.getElementById("out").textContent = t }
document.getElementById("load").onclick = async () => {
  try {
    const files = await aquilla.files.list({ tags: ["e2e"] })
    notesFile = files[0]
    const group = await aquilla.files.group(notesFile.fileId)
    const byRef = await aquilla.cells.byRef({ refs: ["MAT 1:1"], tags: ["e2e"] })
    noteCell = byRef["MAT 1:1"][0]
    out("files " + files.length + " group " + group.key + " note " + noteCell.source + " quote " + noteCell.metadata.Quote)
  } catch (e) { out("error " + (e.code || e.message)) }
}
document.getElementById("anchor").onclick = async () => {
  try {
    await aquilla.data.put("e2e.notes", "MAT 1:1", { checked: true }, { anchor: { fileId: notesFile.fileId, cellId: noteCell.cellId, side: "source" } })
    const d = await aquilla.data.get("e2e.notes", "MAT 1:1")
    out("saved " + d.drift + " " + JSON.stringify(d.doc))
  } catch (e) { out("error " + (e.code || e.message)) }
}
document.getElementById("check").onclick = async () => {
  try {
    const d = await aquilla.data.get("e2e.notes", "MAT 1:1")
    const byRef = await aquilla.cells.byRef({ refs: ["MAT 1:1"], tags: ["e2e"] })
    out("drift " + (d ? d.drift : "none") + " note " + byRef["MAT 1:1"][0].source)
  } catch (e) { out("error " + (e.code || e.message)) }
}
</script></body></html>`
const EDITOR_MANIFEST = { name: EDITOR, description: "Reads notes by verse.", scopes: ["read:cells", "write:data"], mounts: ["page"], apiRev: 7 }

async function install(jwt: string, projectId: string, source: string, manifest: { scopes: string[] }): Promise<string> {
  const res = await fetch(`${AUTH}/api/v2/projects/${projectId}/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ source, manifest, origin: "builder", grant: manifest.scopes }),
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return ((await res.json()) as { tool: { id: string } }).tool.id
}

interface FileRow { fileId: string; name: string; role: string | null; extension: { kind: string; tags: string[]; group?: string; owner?: string } | null }

async function readFiles(jwt: string, projectId: string, anyFileId: string, extensionData = false): Promise<FileRow[]> {
  const token = await mintSyncToken(jwt, projectId, anyFileId)
  const r = await fetch(`${SYNC_BASE}/api/v1/projects/${projectId}/files${extensionData ? "?extensionData=1" : ""}`, { headers: { Authorization: `Bearer ${token}` } })
  expect(r.ok, await r.clone().text()).toBe(true)
  return ((await r.json()) as { files: FileRow[] }).files
}

test("an importer extension creates and refreshes a tagged file, an editor reads it by verse with a drift-checked data record, and its export downloads", async ({ alice }) => {
  test.setTimeout(180_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Primitives ${Date.now()}` })
  const importerId = await install(jwt, seeded.projectId, IMPORTER_SOURCE, IMPORTER_MANIFEST)
  await install(jwt, seeded.projectId, EDITOR_SOURCE, EDITOR_MANIFEST)

  // The site is mocked at the browser: the auth-worker proxy is what the host calls.
  let note = "The book of the genealogy"
  await alice.route(/\/tools\/[^/]+\/web-fetch$/, async (route) => {
    await route.fulfill({ json: { status: 200, contentType: "text/tab-separated-values", url: NOTES_URL, body: tsv(note) } })
  })

  // 1. The settings action runs the importer headless; files.upsert creates the file.
  const tools = new ToolsPage(alice)
  await tools.open(seeded.projectId)
  await tools.installedTool(IMPORTER).getByTestId("extension-settings-action").click()
  await expect(alice.getByText(`${IMPORTER}: Import notes finished`)).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await readFiles(jwt, seeded.projectId, seeded.fileId)).find((f) => f.name === "MAT notes (e2e)")?.extension ?? null, { timeout: 30_000 })
    .toMatchObject({ kind: "normal", tags: ["e2e", "book:MAT"], group: "e2e:MAT", owner: importerId })

  // 2 + 3. The editor finds it by tag and group, reads the verse across files, and anchors a record.
  await alice.goto(`/project/${seeded.projectId}/extensions`)
  await tools.installedTool(EDITOR).getByRole("link").click()
  const frame = tools.toolFrame(EDITOR)
  await frame.getByRole("button", { name: "Load" }).click()
  await expect(frame.locator("#out")).toHaveText("files 1 group e2e:MAT note The book of the genealogy quote Βίβλος γενέσεως", { timeout: 30_000 })
  await frame.getByRole("button", { name: "Anchor" }).click()
  await expect(frame.locator("#out")).toHaveText('saved current {"checked":true}', { timeout: 30_000 })

  // The record lives in a data file: hidden from the ordinary listing, listed for extension hosts.
  await expect.poll(async () => (await readFiles(jwt, seeded.projectId, seeded.fileId, true)).find((f) => f.role === "extension-data")?.extension?.kind ?? null, { timeout: 30_000 }).toBe("data")
  expect((await readFiles(jwt, seeded.projectId, seeded.fileId)).some((f) => f.role === "extension-data")).toBe(false)

  // Upstream changes: the refresh action (on the editor's extensions bar) re-upserts as a delta.
  note = "The record of the ancestry"
  const workspace = new Workspace(alice)
  await alice.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  await workspace.waitForFileInSidebar("MAT notes (e2e)")
  await expect(alice.locator("aside").getByText("(extension data)")).toHaveCount(0)
  await alice.getByTestId("extension-action").filter({ hasText: "Import notes" }).click()
  await expect(alice.getByText(`${IMPORTER}: Import notes finished`)).toBeVisible({ timeout: 30_000 })

  // The anchored record now reads "changed" (the noted cell was edited upstream).
  await alice.goto(`/project/${seeded.projectId}/extensions`)
  await tools.installedTool(EDITOR).getByRole("link").click()
  await expect(async () => {
    await frame.getByRole("button", { name: "Check" }).click()
    await expect(frame.locator("#out")).toHaveText("drift changed note The record of the ancestry", { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })

  // 4. The export format appears for the tagged file and downloads what the extension delivers.
  await alice.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  await workspace.openFileBySubstring("MAT notes \\(e2e\\)")
  await workspace.openExportDialog()
  const exportButton = alice.getByTestId("extension-export").filter({ hasText: "Notes TSV" })
  await expect(exportButton).toBeVisible({ timeout: 30_000 })
  const download = alice.waitForEvent("download")
  await exportButton.click()
  const file = await download
  expect(file.suggestedFilename()).toBe("notes.tsv")
  const text = await (await file.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString("utf8"))
  expect(text).toContain("MAT 1:1\tThe record of the ancestry")
})
