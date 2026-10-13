// Smart Extensions read:web (apiRev 6): an extension that declares
// git.door43.org is prompted the first time it reads it, naming the site; "Not
// now" denies the call; "Always allow" stores a per-user grant and the read
// goes through the auth-worker proxy. The proxy's own refusals (no grant,
// undeclared or internal hosts) are checked against the real worker; the Door43
// answer itself is mocked at the browser (no live network in e2e).

import { test, expect } from "../../helpers/multi-user"
import { ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

const AUTH = process.env.VITE_AUTH_BASE ?? "http://127.0.0.1:8787"
const NAME = "Notes Reader"
const TN_URL = "https://git.door43.org/unfoldingWord/en_tn/raw/branch/master/tn_MAT.tsv"
const SOURCE = `<!doctype html><html><body>
<button id="load">Load notes</button><p id="out">idle</p>
<script>
document.getElementById("load").onclick = async () => {
  const out = document.getElementById("out")
  try {
    const r = await aquilla.web.fetch(${JSON.stringify(TN_URL)})
    const row = String(r.body).split("\\n")[1].split("\\t")
    out.textContent = "MAT " + row[0] + ": " + row[6]
  } catch (e) { out.textContent = "error " + (e.code || e.message) }
}
</script></body></html>`
const MANIFEST = { name: NAME, description: "Shows a translation note.", scopes: ["read:web"], web: ["git.door43.org"], mounts: ["page"], apiRev: 6 }

async function webFetch(jwt: string, projectId: string, toolId: string, url: string) {
  const res = await fetch(`${AUTH}/api/v2/projects/${projectId}/tools/${toolId}/web-fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ url }),
  })
  return { status: res.status, body: (await res.json()) as { error?: { code: string } } }
}

test("an extension asks before reading git.door43.org; denied it gets nothing, allowed it reads through the proxy", async ({ alice }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Web ${Date.now()}` })
  const res = await fetch(`${AUTH}/api/v2/projects/${seeded.projectId}/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ source: SOURCE, manifest: MANIFEST, origin: "builder", grant: [] }),
  })
  expect(res.status, await res.clone().text()).toBe(201)
  const toolId = ((await res.json()) as { tool: { id: string } }).tool.id

  // The proxy refuses a user who has not allowed it — before any network.
  expect(await webFetch(jwt, seeded.projectId, toolId, TN_URL)).toMatchObject({ status: 403, body: { error: { code: "permission_denied" } } })

  const tools = new ToolsPage(alice)
  await alice.goto(`/project/${seeded.projectId}/extensions/${toolId}`)
  const frame = tools.toolFrame(NAME)

  // First read: the prompt names the site, says the site sees the request, and has no "Allow once".
  await frame.getByRole("button", { name: "Load notes" }).click()
  const prompt = tools.permissionPrompt()
  await expect(prompt).toContainText(`${NAME} wants to read from git.door43.org.`)
  await expect(prompt).toContainText("The site can see what this extension asks it for.")
  await expect(prompt.getByRole("button", { name: "Allow once" })).toHaveCount(0)
  await tools.answerPrompt("Deny")
  await expect(frame.locator("#out")).toHaveText("error permission_denied")

  // Allowed (after a reload clears the session's "Not now"): a standing grant, and the read goes out.
  const proxied: string[] = []
  await alice.route(/\/tools\/[^/]+\/web-fetch$/, async (route) => {
    proxied.push((route.request().postDataJSON() as { url: string }).url)
    await route.fulfill({
      json: { status: 200, contentType: "text/tab-separated-values", url: TN_URL, body: "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n1:1\tq3ab\t\trc://*/ta/man/translate/figs-idiom\tΒίβλος γενέσεως\t1\tThe book of the genealogy" },
    })
  })
  await alice.reload()
  await frame.getByRole("button", { name: "Load notes" }).click()
  await tools.answerPrompt("Always")
  await expect(frame.locator("#out")).toHaveText("MAT 1:1: The book of the genealogy")
  expect(proxied).toEqual([TN_URL])

  // The grant is stored per user, and the proxy still refuses undeclared or internal hosts.
  const tool = await fetch(`${AUTH}/api/v2/projects/${seeded.projectId}/tools/${toolId}`, { headers: { Authorization: `Bearer ${jwt}` } })
  expect(((await tool.json()) as { tool: { grantedScopes: string[] } }).tool.grantedScopes).toContain("read:web")
  expect(await webFetch(jwt, seeded.projectId, toolId, "https://example.org/x")).toMatchObject({ status: 403, body: { error: { code: "host_not_allowed" } } })
  expect(await webFetch(jwt, seeded.projectId, toolId, "https://169.254.169.254/latest/meta-data")).toMatchObject({ status: 403, body: { error: { code: "host_blocked" } } })
  expect(await webFetch(jwt, seeded.projectId, toolId, "http://git.door43.org/x")).toMatchObject({ status: 400, body: { error: { code: "invalid_url" } } })
})
