// AQU-1937 — the per-project "Smart Extensions" switch and import
// contributions, end to end:
//   1. OFF (the default): the project is today's Aquilla — no extensions page
//      (an "off" notice), no import contributions in Import, and the
//      auth-worker refuses the tools API.
//   2. A maintainer turns it ON: the first-party "Door43 resources" importer
//      is offered in Import beside the built-in one, and an extension's import
//      contribution appears there too.
//   3. The import runs with the options the platform rendered from the
//      importer's schema (a book chosen in a multiselect), and writes a file
//      with import provenance; "Refresh from source" in the file menu re-runs
//      it with the stored options and only the changed cell changes.
//
// Crosses SPA (settings switch, Import dialog, headless import frame, file
// menu), auth-worker (settings, tools gate, tool session) and sync-worker
// (/import with extension identity, events, files read) over Postgres.

import { test, expect } from "../../helpers/multi-user"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { updateProjectSettings } from "../../helpers/frontier-api"
import { jwtFor, mintSyncToken, seedProjectWithFile } from "../../helpers/seed-project"

const AUTH = process.env.VITE_AUTH_BASE ?? "http://127.0.0.1:8787"
const SYNC_BASE = process.env.E2E_SYNC_BASE ?? `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`
const SITE = "glossary.example.org"

const SOURCE = `<!doctype html><html><body><p>Glossary importer</p><script>
(async () => {
  const ctx = aquilla.context
  if (ctx.mount !== "import" || !ctx.import) return
  const job = ctx.import
  try {
    const books = (job.options.books && job.options.books.length) ? job.options.books : ["TIT", "PHM"]
    let n = 0
    for (const book of books) {
      const r = await aquilla.web.fetch("https://${SITE}/" + book + ".txt")
      const lines = String(r.body).split("\\n").filter(Boolean)
      await aquilla.import.progress(book, n / books.length)
      await aquilla.files.upsert({
        key: "e2e:glossary:" + book, name: book + " glossary", kind: "normal", tags: ["glossary", "book:" + book],
        upstream: { version: lines[0] }, cells: lines.slice(1).map((l, i) => ({ key: "g" + i, value: l, ref: book + " 1:" + (i + 1) })),
      })
      n++
    }
    await aquilla.import.done(job.phase + " " + books.join(","))
  } catch (e) { await aquilla.import.done(String(e.message || e), { ok: false }) }
})()
</script></body></html>`
const MANIFEST = {
  name: "Glossary importer",
  description: "Imports a glossary per book.",
  scopes: ["read:web", "write:files"],
  web: [SITE],
  mounts: ["page"],
  apiRev: 7,
  importers: [{
    id: "glossary",
    label: "Book glossary",
    description: "One glossary file per chosen book.",
    options: [{ key: "books", label: "Books", type: "multiselect", choices: [{ value: "TIT", label: "Titus" }, { value: "PHM", label: "Philemon" }] }],
  }],
}

async function tools(jwt: string, projectId: string, init: RequestInit = {}) {
  return fetch(`${AUTH}/api/v2/projects/${projectId}/tools`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` } })
}

interface FileRow { fileId: string; name: string; extension: { import?: { importer: string; options: Record<string, unknown>; upstream?: Record<string, unknown> } } | null }

async function readFiles(jwt: string, projectId: string, anyFileId: string): Promise<FileRow[]> {
  const token = await mintSyncToken(jwt, projectId, anyFileId)
  const r = await fetch(`${SYNC_BASE}/api/v1/projects/${projectId}/files`, { headers: { Authorization: `Bearer ${token}` } })
  return ((await r.json()) as { files: FileRow[] }).files
}

async function readValues(jwt: string, projectId: string, fileId: string): Promise<string[]> {
  const token = await mintSyncToken(jwt, projectId, fileId)
  const r = await fetch(`${SYNC_BASE}/api/v1/projects/${projectId}/files/${fileId}/cells?side=source`, { headers: { Authorization: `Bearer ${token}` } })
  return ((await r.json()) as { cells: { value: string }[] }).cells.map((c) => c.value)
}

test("Smart Extensions are off by default; switched on, an extension importer runs from Import with options and refreshes from the file menu", async ({ alice }) => {
  test.setTimeout(180_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Flag ${Date.now()}`, smartExtensions: false })
  const workspace = new Workspace(alice)

  // 1. OFF: no extensions anywhere, and the server refuses the tools API.
  expect((await tools(jwt, seeded.projectId)).status).toBe(403)
  await alice.goto(`/project/${seeded.projectId}/extensions`)
  await expect(alice.getByTestId("smart-extensions-off")).toBeVisible()
  await alice.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  await workspace.waitForFileInSidebar(seeded.fileName)
  await workspace.openImportDialog()
  await expect(alice.getByRole("dialog")).toBeVisible()
  await expect(alice.getByTestId("extension-importer")).toHaveCount(0)
  await alice.keyboard.press("Escape")

  // 2. ON (Maintainer+): the first-party Door43 importer and an extension's importer are offered.
  await updateProjectSettings(jwt, seeded.projectId, { smartExtensionsEnabled: true })
  const installed = await tools(jwt, seeded.projectId, { method: "POST", body: JSON.stringify({ source: SOURCE, manifest: MANIFEST, origin: "builder", grant: MANIFEST.scopes }) })
  expect(installed.status, await installed.clone().text()).toBe(201)
  let version = "v1"
  await alice.route(/\/tools\/[^/]+\/web-fetch$/, async (route) => {
    const url = (route.request().postDataJSON() as { url: string }).url
    const book = /\/([A-Z]{3})\.txt$/.exec(url)?.[1] ?? "?"
    await route.fulfill({ json: { status: 200, contentType: "text/plain", url, body: `${version}\n${book} servant\n${book} hope ${version}\n` } })
  })
  await alice.reload()
  await workspace.waitForFileInSidebar(seeded.fileName)
  await workspace.openImportDialog()
  const importers = alice.getByTestId("extension-importer")
  await expect(importers.filter({ hasText: "Door43 resources" })).toBeVisible({ timeout: 30_000 })
  await importers.filter({ hasText: "Book glossary" }).click()

  // 3. Options rendered from the schema; run with one book chosen.
  const panel = alice.getByTestId("extension-import-panel")
  await panel.getByRole("checkbox", { name: "Titus" }).check()
  await panel.getByTestId("extension-import-run").click()
  await expect(panel.getByTestId("extension-import-result")).toHaveText("run TIT", { timeout: 30_000 })
  await panel.getByTestId("extension-import-close").click()

  let file: FileRow | undefined
  await expect.poll(async () => {
    file = (await readFiles(jwt, seeded.projectId, seeded.fileId)).find((f) => f.name === "TIT glossary")
    return file?.extension?.import ?? null
  }, { timeout: 30_000 }).toMatchObject({ importer: "glossary", options: { books: ["TIT"] }, upstream: { version: "v1" } })
  expect((await readFiles(jwt, seeded.projectId, seeded.fileId)).some((f) => f.name === "PHM glossary")).toBe(false)
  await expect.poll(() => readValues(jwt, seeded.projectId, file!.fileId), { timeout: 30_000 }).toEqual(["TIT servant", "TIT hope v1"])

  // Refresh from source (file menu): same options, only the changed cell changes.
  version = "v2"
  await alice.reload()
  await workspace.openFileBySubstring("TIT glossary")
  await workspace.openFileOverflowMenu()
  await alice.getByRole("menuitem", { name: "Refresh from source" }).click()
  await expect(alice.getByText("Refreshed from source")).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => readValues(jwt, seeded.projectId, file!.fileId), { timeout: 30_000 }).toEqual(["TIT servant", "TIT hope v2"])
  await expect.poll(async () => (await readFiles(jwt, seeded.projectId, seeded.fileId)).find((f) => f.fileId === file!.fileId)?.extension?.import?.upstream ?? null, { timeout: 30_000 })
    .toMatchObject({ version: "v2" })
})
